import type { PageServerLoad } from './$types';
import { attachSessionEvidence } from '$lib/server/sessionEvidence';
import { query } from '$lib/server/db';
import { nowIST } from '$lib/server/time';
import { isDateKey } from '$lib/date';

// The session log is paged to keep the page small (worker faces load on click).
const SESSION_PAGE_SIZE = 25;

export const load: PageServerLoad = async ({ locals, url }) => {
	const managerId = locals.user!.id;
	const today = nowIST();
	const from = isDateKey(url.searchParams.get('from') || '')
		? url.searchParams.get('from')!
		: today.subtract(29, 'day').format('YYYY-MM-DD');
	const to = isDateKey(url.searchParams.get('to') || '')
		? url.searchParams.get('to')!
		: today.format('YYYY-MM-DD');
	const requestedPage = Number(url.searchParams.get('session_page') || '1');
	const sessionPage = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
	const [pumps, plants, daily, sessionRows, sessionCount] = await Promise.all([
		query<any>(
			`SELECT pu.id, pu.pump_code FROM pumps pu JOIN plant_manager_assignments pma ON pma.plant_id = pu.plant_id WHERE pma.manager_id = $1 ORDER BY pu.pump_code`,
			[managerId]
		),
		query<any>(
			`SELECT pl.id, pl.name, a.name AS area_name FROM plants pl JOIN areas a ON a.id = pl.area_id JOIN plant_manager_assignments pma ON pma.plant_id = pl.id WHERE pma.manager_id = $1 ORDER BY a.name, pl.name`,
			[managerId]
		),
		query<any>(
			`SELECT pu.id AS pump_id, pu.pump_code, dpa.session_date,
			        COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched)
			        / NULLIF(COUNT(*), 0), 0), 0)::int AS attendance_pct
			 FROM daily_person_attendance dpa JOIN pumps pu ON pu.id = dpa.pump_id
			 JOIN plant_manager_assignments pma ON pma.plant_id = pu.plant_id
			 WHERE pma.manager_id = $1 AND dpa.session_date BETWEEN $2 AND $3
			 GROUP BY pu.id, dpa.session_date ORDER BY dpa.session_date`,
			[managerId, from, to]
		),
		query<any>(
			`SELECT s.id, s.session_date, s.session_type, s.status, s.submitted_at, s.photo_url,
			        s.pairing_status, s.closed_by, s.error_reason, s.location_status, pu.id AS pump_id, pu.pump_code, pl.name AS plant_name,
			        EXISTS (
			          SELECT 1 FROM attendance_review_flags arf
			          WHERE arf.session_id = s.id AND arf.person_id IS NULL AND arf.status = 'open'
			        ) AS group_flagged
			 FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
			 JOIN plants pl ON pl.id = pu.plant_id JOIN plant_manager_assignments pma ON pma.plant_id = pl.id
			 WHERE pma.manager_id = $1 AND s.session_date BETWEEN $2 AND $3
			 ORDER BY s.submitted_at DESC LIMIT $4 OFFSET $5`,
			[managerId, from, to, SESSION_PAGE_SIZE, (sessionPage - 1) * SESSION_PAGE_SIZE]
		),
		query<any>(
			`SELECT count(*)::int AS n FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
			 JOIN plant_manager_assignments pma ON pma.plant_id = pu.plant_id
			 WHERE pma.manager_id = $1 AND s.session_date BETWEEN $2 AND $3`,
			[managerId, from, to]
		)
	]);

	// Same per-worker and fraud evidence the admin pump page shows. Sessions are already limited to
	// this manager's plants, so the evidence is too.
	const sessions = await attachSessionEvidence(sessionRows);
	const sessionTotal = sessionCount[0]?.n ?? 0;
	return {
		pumps,
		plants,
		daily,
		sessions,
		sessionPagination: {
			page: sessionPage,
			total: sessionTotal,
			totalPages: Math.max(1, Math.ceil(sessionTotal / SESSION_PAGE_SIZE))
		},
		filters: { from, to }
	};
};
