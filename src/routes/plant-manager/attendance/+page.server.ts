import type { PageServerLoad } from './$types';
import { attachSessionEvidence, groupShifts } from '$lib/server/sessionEvidence';
import { query } from '$lib/server/db';
import { nowIST } from '$lib/server/time';
import { isDateKey } from '$lib/date';
import { personDayStatuses } from '$lib/server/personCalendar';

// The session log shows one row per shift (pump + date) with its start and end photos side by
// side, paged by shift to keep the page small (worker faces load on click).
const SESSION_PAGE_SIZE = 15;
// Attendance calendar: one row per person of the manager's pumps (or one pump), paged.
const ROSTER_PAGE_SIZE = 50;

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
	const requestedRosterPage = Number(url.searchParams.get('roster_page') || '1');
	const rosterPage =
		Number.isInteger(requestedRosterPage) && requestedRosterPage > 0 ? requestedRosterPage : 1;
	// Only a pump of this manager's plants; anything else means all of them.
	const requestedPump = url.searchParams.get('pump') || '';
	const [pumps, plants, daily, sessionRows, sessionCount] = await Promise.all([
		query<any>(
			`SELECT pu.id, pu.pump_code FROM pumps pu JOIN manager_plants pma ON pma.plant_id = pu.plant_id WHERE pma.manager_id = $1 ORDER BY pu.pump_code`,
			[managerId]
		),
		query<any>(
			`SELECT pl.id, pl.name, a.name AS area_name FROM plants pl JOIN areas a ON a.id = pl.area_id JOIN manager_plants pma ON pma.plant_id = pl.id WHERE pma.manager_id = $1 ORDER BY a.name, pl.name`,
			[managerId]
		),
		query<any>(
			`SELECT pu.id AS pump_id, pu.pump_code, dpa.session_date,
			        COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched)
			        / NULLIF(COUNT(*), 0), 0), 0)::int AS attendance_pct
			 FROM daily_person_attendance dpa JOIN pumps pu ON pu.id = dpa.pump_id
			 JOIN manager_plants pma ON pma.plant_id = pu.plant_id
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
			 JOIN plants pl ON pl.id = pu.plant_id JOIN manager_plants pma ON pma.plant_id = pl.id
			 JOIN (
			   SELECT s2.pump_id, s2.session_date, max(s2.submitted_at) AS last_at
			   FROM attendance_sessions s2 JOIN pumps pu2 ON pu2.id = s2.pump_id
			   JOIN manager_plants pma2 ON pma2.plant_id = pu2.plant_id
			   WHERE pma2.manager_id = $1 AND s2.session_date BETWEEN $2 AND $3
			   GROUP BY s2.pump_id, s2.session_date
			   ORDER BY s2.session_date DESC, last_at DESC LIMIT $4 OFFSET $5
			 ) shift ON shift.pump_id = s.pump_id AND shift.session_date = s.session_date
			 WHERE pma.manager_id = $1
			 ORDER BY shift.session_date DESC, shift.last_at DESC, s.submitted_at`,
			[managerId, from, to, SESSION_PAGE_SIZE, (sessionPage - 1) * SESSION_PAGE_SIZE]
		),
		query<any>(
			`SELECT count(DISTINCT (s.pump_id, s.session_date))::int AS n
			 FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
			 JOIN manager_plants pma ON pma.plant_id = pu.plant_id
			 WHERE pma.manager_id = $1 AND s.session_date BETWEEN $2 AND $3`,
			[managerId, from, to]
		)
	]);

	const pumpFilter = pumps.some((p: any) => p.id === requestedPump) ? requestedPump : '';
	const rosterPumpIds = pumpFilter ? [pumpFilter] : pumps.map((p: any) => p.id);
	const [roster, rosterCount] = await Promise.all([
		query<any>(
			`SELECT p.id, p.display_seq, p.name, p.is_operator, pu.pump_code
			 FROM persons p JOIN pumps pu ON pu.id = p.pump_id
			 WHERE p.pump_id = ANY($1) AND p.status = 'active'
			 ORDER BY pu.pump_code, p.display_seq
			 LIMIT $2 OFFSET $3`,
			[rosterPumpIds, ROSTER_PAGE_SIZE, (rosterPage - 1) * ROSTER_PAGE_SIZE]
		),
		query<any>(
			`SELECT count(*)::int AS n FROM persons WHERE pump_id = ANY($1) AND status = 'active'`,
			[rosterPumpIds]
		)
	]);
	const attendanceMap = await personDayStatuses(
		roster.map((p: any) => p.id),
		from,
		to
	);
	const rosterTotal = rosterCount[0]?.n ?? 0;

	// Same per-worker and fraud evidence the admin pump page shows. Sessions are already limited to
	// this manager's plants, so the evidence is too.
	const sessions = await attachSessionEvidence(sessionRows);
	const sessionTotal = sessionCount[0]?.n ?? 0;
	return {
		pumps,
		plants,
		daily,
		shifts: groupShifts(sessions),
		sessionPagination: {
			page: sessionPage,
			pageSize: SESSION_PAGE_SIZE,
			total: sessionTotal,
			totalPages: Math.max(1, Math.ceil(sessionTotal / SESSION_PAGE_SIZE))
		},
		roster,
		attendanceMap,
		rosterPagination: {
			page: rosterPage,
			pageSize: ROSTER_PAGE_SIZE,
			total: rosterTotal,
			totalPages: Math.max(1, Math.ceil(rosterTotal / ROSTER_PAGE_SIZE))
		},
		filters: { from, to, pump: pumpFilter }
	};
};
