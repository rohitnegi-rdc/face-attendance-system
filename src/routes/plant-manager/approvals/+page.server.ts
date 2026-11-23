import type { PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { locationIssueText } from '$lib/server/locationCheck';
import { listOpenFraud } from '$lib/server/navCounts';

// Shift starts (and, with pump gangs, shift ends) whose location could not be verified, for this manager's plants: those waiting for a
// decision (asked by email), those still in the GPS wait (worker/locationHold.js may clear them on
// its own), plus decisions from the last 30 days.
export const load: PageServerLoad = async ({ locals }) => {
	const rows = await query<any>(
		`SELECT s.id, s.session_date::text AS session_date, s.location_status, s.location_issue,
		        s.location_distance_m, s.pump_gps_at, s.location_note,
		        s.location_asked_at IS NOT NULL AS asked, s.location_auto_cleared_at IS NOT NULL AS auto_cleared,
		        to_char(s.location_ask_at AT TIME ZONE 'Asia/Kolkata', 'FMHH12:MI am') AS ask_at,
		        to_char(s.submitted_at AT TIME ZONE 'Asia/Kolkata', 'DD-MM-YYYY, HH12:MI am') AS sent_at,
		        to_char(s.location_decided_at AT TIME ZONE 'Asia/Kolkata', 'DD-MM-YYYY, HH12:MI am') AS decided_at,
		        pu.pump_code, pl.name AS plant_name, pm.name AS decided_by
		 FROM attendance_sessions s
		 JOIN pumps pu ON pu.id = s.pump_id JOIN plants pl ON pl.id = pu.plant_id
		 JOIN manager_plants pma ON pma.plant_id = pl.id AND pma.manager_id = $1
		 LEFT JOIN plant_managers pm ON pm.id = s.location_decided_by
		 WHERE s.location_status = 'pending'
		    OR (s.location_status IN ('approved', 'rejected')
		        AND s.location_decided_at > now() - interval '30 days')
		 ORDER BY (s.location_status = 'pending') DESC, s.submitted_at DESC
		 LIMIT 200`,
		[locals.user!.id]
	);
	const fraud = await listOpenFraud('plant-manager', locals.user!.id);
	const items = rows.map((row) => ({
		...row,
		reason: locationIssueText(row.location_issue, row.location_distance_m, row.pump_gps_at)
	}));
	return {
		pending: items.filter((item) => item.location_status === 'pending' && item.asked),
		checking: items.filter((item) => item.location_status === 'pending' && !item.asked),
		decided: items.filter((item) => item.location_status !== 'pending'),
		fraud
	};
};
