// Pump GPS feed: every PUMP_GPS_POLL_MINUTES (default 5) the worker copies recent pump positions
// from the optimizer database (table dump.pump_events, filled by the pump telematics feed about
// every 10 minutes per pump) into pump_locations, where the shift start location check
// (src/lib/server/locationCheck.ts) reads them.
//
// The optimizer database is only read: the connection runs with default_transaction_read_only.
// Configuration (off when PUMP_GPS_DB_USER is empty; then every shift start in a checked area goes
// to the plant manager as "no pump GPS"):
//   PUMP_GPS_DB_HOST / PUMP_GPS_DB_PORT / PUMP_GPS_DB_USER / PUMP_GPS_DB_PASSWORD / PUMP_GPS_DB_NAME
//
// A feed row is matched to a pump by pumps.gps_device_id, else pump_code (case-insensitive).
// event_timestamp is a timestamptz, so no time zone guessing is needed.
import pg from 'pg';

// Rows older than this are not copied: the check only accepts readings up to 30 minutes old.
const LOOKBACK = '2 hours';

let source = null;
function sourcePool() {
	if (!process.env.PUMP_GPS_DB_USER) return null;
	source ??= new pg.Pool({
		host: process.env.PUMP_GPS_DB_HOST,
		port: Number(process.env.PUMP_GPS_DB_PORT || 5432),
		user: process.env.PUMP_GPS_DB_USER,
		password: process.env.PUMP_GPS_DB_PASSWORD,
		database: process.env.PUMP_GPS_DB_NAME,
		max: 1,
		connectionTimeoutMillis: 10000,
		options: '-c default_transaction_read_only=on -c statement_timeout=30000'
	});
	return source;
}

// Valid coordinate from the feed's text columns; null for blanks, junk and the 0,0 "no fix".
function coordinate(lat, lng) {
	if (lat == null || lng == null || String(lat).trim() === '' || String(lng).trim() === '') {
		return null;
	}
	const a = Number(lat);
	const b = Number(lng);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
	if (Math.abs(a) > 90 || Math.abs(b) > 180 || (a === 0 && b === 0)) return null;
	return { lat: a, lng: b };
}

export async function pollPumpGps(pool, log) {
	const feed = sourcePool();
	if (!feed) return { skipped: true };
	// Several workers may run: only one polls per cycle.
	const client = await pool.connect();
	try {
		const { rows } = await client.query(
			`SELECT pg_try_advisory_lock(hashtext('pump-gps-poll')) AS got`
		);
		if (!rows[0].got) return { skipped: true };
		try {
			const { rows: events } = await feed.query(
				`SELECT trim(pump_id) AS id, latitude, longitude, event_timestamp
				 FROM dump.pump_events
				 WHERE event_timestamp > now() - interval '${LOOKBACK}'
				   AND event_timestamp <= now() + interval '5 minutes'`
			);
			let stored = 0;
			const unmatched = new Set();
			for (const event of events) {
				const point = coordinate(event.latitude, event.longitude);
				if (!event.id || !point) continue;
				const result = await client.query(
					`INSERT INTO pump_locations (pump_id, lat, lng, recorded_at, source)
					 SELECT pu.id, $2, $3, $4, 'gps_api' FROM pumps pu
					 WHERE lower(pu.gps_device_id) = lower($1)
					    OR (pu.gps_device_id IS NULL AND lower(pu.pump_code) = lower($1))
					 LIMIT 1
					 ON CONFLICT (pump_id, recorded_at) DO NOTHING
					 RETURNING id`,
					[event.id, point.lat, point.lng, event.event_timestamp]
				);
				if (result.rowCount) {
					stored += 1;
					continue;
				}
				const known = await client.query(
					`SELECT 1 FROM pumps WHERE lower(gps_device_id) = lower($1) OR lower(pump_code) = lower($1)`,
					[event.id]
				);
				if (!known.rowCount) unmatched.add(event.id);
			}
			// Keep 30 days of history; the check only needs the latest reading.
			await client.query(
				`DELETE FROM pump_locations WHERE recorded_at < now() - interval '30 days'`
			);
			log(
				'info',
				{ received: events.length, stored, unmatched: [...unmatched].slice(0, 20) },
				'pump GPS poll done'
			);
			return { received: events.length, stored, unmatched: [...unmatched] };
		} finally {
			await client.query(`SELECT pg_advisory_unlock(hashtext('pump-gps-poll'))`);
		}
	} finally {
		client.release();
	}
}
