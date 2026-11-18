// The Pump GPS page (/admin/pump-gps): every pump's latest position as the worker copied it from
// the GPS feed (worker/gpsFeed.js, every 5 minutes into pump_locations), whether the shift start
// check can use it, and how many feed positions arrived in the last 24 hours. Problems first.
import { query } from '$lib/server/db';
import { PUMP_GPS_MAX_AGE_MINUTES } from '$lib/server/locationCheck';
import type { GpsState } from '$lib/gpsAge';

export type PumpGpsRow = {
	id: string;
	pump_code: string;
	gps_name: string;
	has_provider_id: boolean;
	vendor_name: string;
	plant_id: string;
	plant_name: string;
	area_id: string;
	area_name: string;
	location_check: boolean;
	lat: number | null;
	lng: number | null;
	source: 'gps_api' | 'admin' | null;
	at: string | null;
	age_minutes: number | null;
	feed_24h: number;
	state: GpsState;
};

export const GPS_STATES: GpsState[] = ['none', 'old', 'fresh'];

// Pumps whose login is disabled are left out.
export async function listPumpGps(q: string, areaId: string) {
	const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	return query<PumpGpsRow>(
		`SELECT pu.id, pu.pump_code, coalesce(pu.gps_device_id, pu.pump_code) AS gps_name,
		        pu.gps_device_id IS NOT NULL AS has_provider_id, v.name AS vendor_name,
		        pl.id AS plant_id, pl.name AS plant_name, a.id AS area_id, a.name AS area_name,
		        a.location_check_enabled AS location_check,
		        l.lat, l.lng, l.source,
		        to_char(l.recorded_at AT TIME ZONE 'Asia/Kolkata', 'Dy, FMDD Mon YYYY, FMHH12:MI am') AS at,
		        floor(extract(epoch FROM now() - l.recorded_at) / 60)::int AS age_minutes,
		        (SELECT count(*)::int FROM pump_locations c
		          WHERE c.pump_id = pu.id AND c.source = 'gps_api'
		            AND c.recorded_at > now() - interval '24 hours') AS feed_24h,
		        CASE WHEN l.recorded_at IS NULL THEN 'none'
		             WHEN l.recorded_at < now() - make_interval(mins => $4) THEN 'old'
		             ELSE 'fresh' END AS state
		 FROM pumps pu
		 JOIN plants pl ON pl.id = pu.plant_id
		 JOIN areas a ON a.id = pl.area_id
		 JOIN vendors v ON v.id = pu.vendor_id
		 LEFT JOIN LATERAL (
		   SELECT lat, lng, source, recorded_at FROM pump_locations
		   WHERE pump_id = pu.id ORDER BY recorded_at DESC LIMIT 1
		 ) l ON true
		 WHERE pu.status <> 'disabled' AND pu.disabled_at IS NULL
		   AND ($1 = '' OR pu.pump_code ILIKE $2 OR pu.gps_device_id ILIKE $2 OR pl.name ILIKE $2
		        OR a.name ILIKE $2 OR v.name ILIKE $2)
		   AND ($3 = '' OR a.id::text = $3)
		 ORDER BY a.name, pl.name,
		          CASE WHEN l.recorded_at IS NULL THEN 0
		               WHEN l.recorded_at < now() - make_interval(mins => $4) THEN 1 ELSE 2 END,
		          pu.pump_code`,
		[q, like, areaId, PUMP_GPS_MAX_AGE_MINUTES]
	);
}
