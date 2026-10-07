import type { PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { nowIST } from '$lib/server/time';
import { isDateKey } from '$lib/date';

export const load: PageServerLoad = async ({ locals, url }) => {
	const managerId = locals.user!.id;
	const today = nowIST();
	const from = isDateKey(url.searchParams.get('from') || '') ? url.searchParams.get('from')! : today.subtract(13, 'day').format('YYYY-MM-DD');
	const to = isDateKey(url.searchParams.get('to') || '') ? url.searchParams.get('to')! : today.format('YYYY-MM-DD');
	const [pumps, plants, daily, records, sessions] = await Promise.all([
		query<any>(`SELECT pu.id, pu.pump_code FROM pumps pu JOIN plant_manager_assignments pma ON pma.plant_id = pu.plant_id WHERE pma.manager_id = $1 ORDER BY pu.pump_code`, [managerId]),
		query<any>(`SELECT pl.id, pl.name, a.name AS area_name FROM plants pl JOIN areas a ON a.id = pl.area_id JOIN plant_manager_assignments pma ON pma.plant_id = pl.id WHERE pma.manager_id = $1 ORDER BY a.name, pl.name`, [managerId]),
		query<any>(
			`SELECT pu.id AS pump_id, pu.pump_code, dpa.session_date,
			        COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched)
			        / NULLIF(COUNT(*), 0), 0), 0)::int AS attendance_pct
			 FROM daily_person_attendance dpa JOIN pumps pu ON pu.id = dpa.pump_id
			 JOIN plant_manager_assignments pma ON pma.plant_id = pu.plant_id
			 WHERE pma.manager_id = $1 AND dpa.session_date BETWEEN $2 AND $3
			 GROUP BY pu.id, dpa.session_date ORDER BY dpa.session_date`, [managerId, from, to]
		),
		query<any>(
			`SELECT dpa.session_date, dpa.morning_matched, dpa.evening_matched, p.display_seq,
			        pu.pump_code, pl.name AS plant_name, a.name AS area_name
			 FROM daily_person_attendance dpa JOIN persons p ON p.id = dpa.person_id
			 JOIN pumps pu ON pu.id = dpa.pump_id JOIN plants pl ON pl.id = pu.plant_id
			 JOIN areas a ON a.id = pl.area_id JOIN plant_manager_assignments pma ON pma.plant_id = pl.id
			 WHERE pma.manager_id = $1 AND dpa.session_date BETWEEN $2 AND $3
			 ORDER BY dpa.session_date DESC, pu.pump_code, p.display_seq LIMIT 500`, [managerId, from, to]
		),
		query<any>(
			`SELECT s.id, s.session_date, s.session_type, s.status, s.submitted_at, s.photo_url,
			        pu.pump_code, pl.name AS plant_name
			 FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
			 JOIN plants pl ON pl.id = pu.plant_id JOIN plant_manager_assignments pma ON pma.plant_id = pl.id
			 WHERE pma.manager_id = $1 AND s.session_date BETWEEN $2 AND $3
			 ORDER BY s.submitted_at DESC LIMIT 200`, [managerId, from, to]
		)
	]);
	return { pumps, plants, daily, records, sessions, filters: { from, to } };
};
