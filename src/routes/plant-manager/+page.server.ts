import type { PageServerLoad } from './$types';
import { query, queryOne } from '$lib/server/db';
import { todayIST } from '$lib/server/time';

export const load: PageServerLoad = async ({ locals }) => {
	const managerId = locals.user!.id;
	const today = todayIST();
	const [summary, plants, pumps, recent] = await Promise.all([
		queryOne<any>(
			`SELECT COUNT(DISTINCT pu.id)::int AS pump_count,
			        COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'active')::int AS people_count,
			        COUNT(DISTINCT dpa.person_id) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched)::int AS present_today,
			        COUNT(DISTINCT s.id) FILTER (WHERE s.session_date = $2 AND s.pairing_status = 'open')::int AS open_sessions
			 FROM plant_manager_assignments pma
			 JOIN pumps pu ON pu.plant_id = pma.plant_id
			 LEFT JOIN persons p ON p.pump_id = pu.id
			 LEFT JOIN daily_person_attendance dpa ON dpa.person_id = p.id AND dpa.session_date = $2
			 LEFT JOIN attendance_sessions s ON s.pump_id = pu.id
			 WHERE pma.manager_id = $1`, [managerId, today]
		),
		query<any>(
			`SELECT pl.id, pl.name, a.name AS area_name, COUNT(DISTINCT pu.id)::int AS pump_count,
			        COUNT(DISTINCT s.id) FILTER (WHERE s.session_date = $2)::int AS sessions_today
			 FROM plant_manager_assignments pma JOIN plants pl ON pl.id = pma.plant_id
			 JOIN areas a ON a.id = pl.area_id LEFT JOIN pumps pu ON pu.plant_id = pl.id
			 LEFT JOIN attendance_sessions s ON s.pump_id = pu.id
			 WHERE pma.manager_id = $1 GROUP BY pl.id, a.name ORDER BY a.name, pl.name`, [managerId, today]
		),
		query<any>(
			`SELECT pu.id, pu.pump_code, pl.name AS plant_name, a.name AS area_name,
			        latest.submitted_at, latest.session_type, latest.status
			 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
			 JOIN plant_manager_assignments pma ON pma.plant_id = pl.id AND pma.manager_id = $1
			 LEFT JOIN LATERAL (SELECT submitted_at, session_type, status FROM attendance_sessions
			   WHERE pump_id = pu.id ORDER BY submitted_at DESC LIMIT 1) latest ON true
			 ORDER BY latest.submitted_at DESC NULLS LAST, pu.pump_code LIMIT 12`, [managerId]
		),
		query<any>(
			`SELECT s.id, s.session_date, s.session_type, s.status, s.submitted_at, s.photo_url,
			        pu.pump_code, pl.name AS plant_name
			 FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
			 JOIN plant_manager_assignments pma ON pma.plant_id = pu.plant_id AND pma.manager_id = $1
			 JOIN plants pl ON pl.id = pu.plant_id
			 ORDER BY s.submitted_at DESC LIMIT 10`, [managerId]
		)
	]);
	return { summary: summary ?? {}, plants, pumps, recent };
};
