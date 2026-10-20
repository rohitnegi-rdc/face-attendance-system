import type { PageServerLoad } from './$types';
import { resolve } from '$app/paths';
import { query } from '$lib/server/db';
import { nowIST } from '$lib/server/time';
import { isDateKey } from '$lib/date';

// Face crops are stored inline, so the session log is paged to keep the page small.
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
	const [pumps, plants, daily, records, sessionRows, sessionCount] = await Promise.all([
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
			`SELECT dpa.session_date, dpa.morning_matched, dpa.evening_matched, p.display_seq,
			        pu.pump_code, pl.name AS plant_name, a.name AS area_name
			 FROM daily_person_attendance dpa JOIN persons p ON p.id = dpa.person_id
			 JOIN pumps pu ON pu.id = dpa.pump_id JOIN plants pl ON pl.id = pu.plant_id
			 JOIN areas a ON a.id = pl.area_id JOIN plant_manager_assignments pma ON pma.plant_id = pl.id
			 WHERE pma.manager_id = $1 AND dpa.session_date BETWEEN $2 AND $3
			 ORDER BY dpa.session_date DESC, pu.pump_code, p.display_seq LIMIT 500`,
			[managerId, from, to]
		),
		query<any>(
			`SELECT s.id, s.session_date, s.session_type, s.status, s.submitted_at, s.photo_url,
			        s.pairing_status, s.closed_by, s.error_reason, s.location_status, pu.pump_code, pl.name AS plant_name,
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

	// Same per-worker evidence the admin pump page shows. Sessions are already limited to this
	// manager's plants, so the evidence is too.
	const sessionIds = sessionRows.map((session: any) => session.id);
	const faces = sessionIds.length
		? await query<any>(
				`SELECT afe.session_id, afe.person_id, afe.face_crop_url, p.display_seq,
				        EXISTS (
				          SELECT 1 FROM attendance_review_flags arf
				          WHERE arf.session_id = afe.session_id
				            AND arf.person_id = afe.person_id AND arf.status = 'open'
				        ) AS flagged
				 FROM attendance_face_evidence afe JOIN persons p ON p.id = afe.person_id
				 WHERE afe.session_id = ANY($1)
				 ORDER BY p.display_seq`,
				[sessionIds]
			)
		: [];
	const peopleBySession = new Map<string, any[]>();
	for (const face of faces) {
		const people = peopleBySession.get(face.session_id) ?? [];
		people.push({
			personId: face.person_id,
			label: `Worker ${face.display_seq}`,
			cropUrl: face.face_crop_url,
			flagged: face.flagged
		});
		peopleBySession.set(face.session_id, people);
	}
	const sessions = sessionRows.map(({ photo_url, ...session }: any) => ({
		...session,
		evidence: {
			id: session.id,
			sessionType: session.session_type,
			groupPhotoUrl: photo_url ? resolve(`/api/attendance/photo/${session.id}`) : null,
			groupFlagged: session.group_flagged,
			people: peopleBySession.get(session.id) ?? []
		}
	}));
	const sessionTotal = sessionCount[0]?.n ?? 0;
	return {
		pumps,
		plants,
		daily,
		records,
		sessions,
		sessionPagination: {
			page: sessionPage,
			total: sessionTotal,
			totalPages: Math.max(1, Math.ceil(sessionTotal / SESSION_PAGE_SIZE))
		},
		filters: { from, to }
	};
};
