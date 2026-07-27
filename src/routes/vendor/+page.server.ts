import type { PageServerLoad } from './$types';
import { query, queryOne } from '$lib/server/db';
import { todayIST } from '$lib/server/time';

export const load: PageServerLoad = async ({ locals }) => {
	const vendorId = locals.user!.id;
	const today = todayIST();
	const [summary, trend, pumps] = await Promise.all([
		queryOne<any>(
			`SELECT
			   (SELECT COUNT(*) FROM pumps WHERE vendor_id = $1) AS active_pumps,
			   (SELECT COUNT(*) FROM persons p JOIN pumps pu ON pu.id = p.pump_id
			    WHERE pu.vendor_id = $1 AND p.status = 'active') AS known_people,
			   (SELECT COUNT(*) FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
			    WHERE pu.vendor_id = $1 AND s.session_date = $2
			      AND s.session_type = 'morning' AND s.pairing_status = 'open') AS incomplete_sessions,
			   (SELECT COALESCE(ROUND(
			      100.0 * COUNT(dpa.id) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched)
			      / NULLIF(COUNT(dpa.id), 0)
			    , 0), 0)::int
			    FROM daily_person_attendance dpa JOIN pumps pu ON pu.id = dpa.pump_id
			    WHERE pu.vendor_id = $1
			      AND dpa.session_date BETWEEN $2::date - interval '29 days' AND $2::date) AS attendance_pct`,
			[vendorId, today]
		),
		query<any>(
			`WITH days AS (
			   SELECT generate_series($2::date - interval '29 days', $2::date, interval '1 day')::date AS day
			 )
			 SELECT days.day,
			        COALESCE(ROUND(
			          100.0 * COUNT(dpa.id) FILTER (
			            WHERE pu.id IS NOT NULL AND dpa.morning_matched AND dpa.evening_matched
			          )
			          / NULLIF(COUNT(dpa.id) FILTER (WHERE pu.id IS NOT NULL), 0)
			        , 0), 0)::int AS attendance_pct
			 FROM days
			 LEFT JOIN daily_person_attendance dpa ON dpa.session_date = days.day
			 LEFT JOIN pumps pu ON pu.id = dpa.pump_id AND pu.vendor_id = $1
			 GROUP BY days.day ORDER BY days.day`,
			[vendorId, today]
		),
		query<any>(
			`SELECT pu.id, pu.pump_code, pl.name AS plant_name, a.name AS area_name,
			        latest.submitted_at AS latest_submission, latest.status AS latest_status,
			        COALESCE(ROUND(
			          100.0 * COUNT(dpa.id) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched)
			          / NULLIF(COUNT(dpa.id), 0)
			        , 0), 0)::int AS attendance_pct
			 FROM pumps pu
			 JOIN plants pl ON pl.id = pu.plant_id
			 JOIN areas a ON a.id = pl.area_id
			 LEFT JOIN daily_person_attendance dpa ON dpa.pump_id = pu.id
			   AND dpa.session_date BETWEEN $2::date - interval '29 days' AND $2::date
			 LEFT JOIN LATERAL (
			   SELECT submitted_at, status FROM attendance_sessions
			   WHERE pump_id = pu.id ORDER BY submitted_at DESC LIMIT 1
			 ) latest ON true
			 WHERE pu.vendor_id = $1
			 GROUP BY pu.id, pl.name, a.name, latest.submitted_at, latest.status
			 ORDER BY latest.submitted_at ASC NULLS FIRST, attendance_pct ASC`,
			[vendorId, today]
		)
	]);
	return { summary, trend, pumps };
};
