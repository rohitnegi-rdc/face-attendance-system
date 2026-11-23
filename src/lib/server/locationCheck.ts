// Shift start location check: the operator's phone position against the pump's latest GPS
// reading (copied from the optimizer database every 5 minutes by worker/gpsFeed.js into
// pump_locations).
// Within range the shift starts normally; otherwise it starts on hold. The worker
// (worker/locationHold.js) then waits location_hold_minutes for the pump GPS to show the pump at
// the photo spot, clearing it on its own, and otherwise asks the plant managers of the pump's plant
// and the monitors of its Area to approve or reject it (email with Approve and Reject buttons, when
// the admin has the email switched on at /admin/settings). Only areas with location_check_enabled
// (ticked per Area on the same page) are checked.
import type { PoolClient } from 'pg';

export const LOCATION_RADIUS_M = 100;
// Pumps report about every 10 minutes and the worker copies every 5; 30 minutes allows a missed
// report before the reading counts as stale.
export const PUMP_GPS_MAX_AGE_MINUTES = 30;

// SQL value: 'pending' or 'rejected' when the pump's shift start on that date waits for the plant
// manager's location approval or was rejected, else NULL. Reports show such a day, marked, and
// leave it out of their counts until it is approved ('rejected' sorts after 'pending', so max()
// reports a rejection first). Only starts are checked: a shift end never is.
export const heldShiftStatus = (pumpColumn: string, dateColumn: string) =>
	`(SELECT max(held.location_status) FROM attendance_sessions held
	  WHERE held.pump_id = ${pumpColumn} AND held.session_date = ${dateColumn}
	    AND held.session_type = 'morning' AND held.location_status IN ('pending', 'rejected'))`;

export type LocationIssue = 'too_far' | 'no_phone_location' | 'no_pump_gps' | 'stale_pump_gps';

export type LocationCheck = {
	status: 'ok' | 'pending';
	issue: LocationIssue | null;
	distanceM: number | null;
	pumpLat: number | null;
	pumpLng: number | null;
	pumpAt: Date | null;
};

// Great-circle distance in metres.
export function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number) {
	const rad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = rad(lat2 - lat1);
	const dLng = rad(lng2 - lng1);
	const a =
		Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
	return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

export function validCoordinate(lat: number | null, lng: number | null) {
	return (
		lat !== null &&
		lng !== null &&
		Number.isFinite(lat) &&
		Number.isFinite(lng) &&
		Math.abs(lat) <= 90 &&
		Math.abs(lng) <= 180 &&
		!(lat === 0 && lng === 0)
	);
}

// The plain-words reason shown to the operator, in the email and on the approval page.
export function locationIssueText(
	issue: string | null,
	distanceM: number | null,
	pumpAt: Date | string | null
) {
	switch (issue) {
		case 'too_far':
			return `The operator was ${distanceM ?? '?'} m from the pump (allowed: ${LOCATION_RADIUS_M} m).`;
		case 'no_phone_location':
			return "The operator's phone did not share its location.";
		case 'no_pump_gps':
			return 'No GPS position has been received for this pump.';
		case 'stale_pump_gps': {
			const minutes = pumpAt ? Math.round((Date.now() - new Date(pumpAt).getTime()) / 60000) : null;
			return `The pump's last GPS position is ${minutes ?? 'over ' + PUMP_GPS_MAX_AGE_MINUTES} minutes old, so the distance could not be checked.`;
		}
		default:
			return '';
	}
}

// null = this pump's area does not use the location check.
export async function checkShiftStartLocation(
	client: PoolClient,
	pumpId: string,
	phoneLat: number | null,
	phoneLng: number | null
): Promise<LocationCheck | null> {
	const { rows } = await client.query(
		`SELECT a.location_check_enabled AS enabled, l.lat, l.lng, l.recorded_at
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		 LEFT JOIN LATERAL (
		   SELECT lat, lng, recorded_at FROM pump_locations
		   WHERE pump_id = pu.id ORDER BY recorded_at DESC LIMIT 1
		 ) l ON true
		 WHERE pu.id = $1`,
		[pumpId]
	);
	const row = rows[0];
	if (!row?.enabled) return null;

	const pump = {
		pumpLat: row.lat as number | null,
		pumpLng: row.lng as number | null,
		pumpAt: row.recorded_at as Date | null
	};
	const hold = (issue: LocationIssue, distanceM: number | null = null): LocationCheck => ({
		status: 'pending',
		issue,
		distanceM,
		...pump
	});

	const hasPhone = validCoordinate(phoneLat, phoneLng);
	const distanceM =
		hasPhone && row.lat !== null
			? Math.round(distanceMetres(phoneLat!, phoneLng!, row.lat, row.lng))
			: null;
	if (!hasPhone) return hold('no_phone_location');
	if (row.lat === null) return hold('no_pump_gps');
	const ageMinutes = (Date.now() - new Date(row.recorded_at).getTime()) / 60000;
	if (ageMinutes > PUMP_GPS_MAX_AGE_MINUTES) return hold('stale_pump_gps', distanceM);
	if (distanceM! > LOCATION_RADIUS_M) return hold('too_far', distanceM);
	return { status: 'ok', issue: null, distanceM, ...pump };
}
