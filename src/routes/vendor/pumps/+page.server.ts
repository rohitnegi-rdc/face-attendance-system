import type { PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { todayIST } from '$lib/server/time';

export const load: PageServerLoad = async ({ locals }) => {
	const pumps = await query<any>(
		`SELECT pu.id, pu.pump_code, pl.name AS plant_name, a.name AS area_name,
		        latest.submitted_at AS latest_submission, latest.session_type, latest.status,
		        COALESCE(ROUND(100.0 * COUNT(dpa.id) FILTER (
		          WHERE dpa.morning_matched AND dpa.evening_matched
		        ) / NULLIF(COUNT(dpa.id), 0), 0), 0)::int AS attendance_pct
		 FROM pumps pu
		 JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		 LEFT JOIN daily_person_attendance dpa ON dpa.pump_id = pu.id
		   AND dpa.session_date BETWEEN $2::date - interval '29 days' AND $2::date
		 LEFT JOIN LATERAL (
		   SELECT submitted_at, session_type, status FROM attendance_sessions
		   WHERE pump_id = pu.id ORDER BY submitted_at DESC LIMIT 1
		 ) latest ON true
		 WHERE pu.vendor_id = $1
		 GROUP BY pu.id, pl.name, a.name, latest.submitted_at, latest.session_type, latest.status
		 ORDER BY a.name, pl.name, pu.pump_code`,
		[locals.user!.id, todayIST()]
	);
	return { pumps };
};
