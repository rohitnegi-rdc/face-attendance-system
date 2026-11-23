// Pump gangs (migration 056, worker/gangs.js): crews recognised from faces that move between the
// pumps of an Area. This is the read side shared by the Gangs pages (admin and plant manager), the
// Gangs sheet of the headcount workbook and the attendance page's By gang view, plus the two
// fixes people make by hand: move a shift to another gang, and answer "Same person?".
//
// Headcount per gang and day (the same rule everywhere): the workers the pump sheet counts that
// day (daily_person_attendance, regularised and hand-added days included), each given to a gang:
//   - a pump with one gang that day gives every one of its workers to that gang;
//   - a pump with two gangs gives a worker to the gang whose photo has their face, and a worker
//     with no face that day (hand-added, regularised) to the gang that started first.
// A worker is counted once a day per gang (area_workers link the same person across pumps), so a
// gang that moved from one pump to another that day counts each worker once.
import { error, fail } from '@sveltejs/kit';
import { pool, query, queryOne } from '$lib/server/db';
import { addDaysStr, isDateKey } from '$lib/date';
import { todayIST } from '$lib/server/time';
import { logger } from '$lib/server/log';
import { gangDaySql } from '../../../worker/gangs.js';

export { gangDaySql };

export type GangViewer = { role: 'admin' | 'plant-manager'; id: string };
export type HeldState = 'pending' | 'rejected' | null;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A gang is visible to the admin, and to a plant manager or monitor when it worked at one of
// their pumps ($1 role, $2 viewer id).
const GANG_ALLOWED = (gang: string) => `($1 = 'admin' OR EXISTS (
	SELECT 1 FROM attendance_sessions vs JOIN pumps vp ON vp.id = vs.pump_id
	JOIN manager_plants mp ON mp.plant_id = vp.plant_id AND mp.manager_id = $2::uuid
	WHERE vs.gang_id = ${gang}.id))`;
const PUMP_ALLOWED = (pump: string) => `($1 = 'admin' OR EXISTS (
	SELECT 1 FROM manager_plants mp WHERE mp.plant_id = ${pump}.plant_id AND mp.manager_id = $2::uuid))`;

export type GangPumpDay = {
	gang_id: string;
	pump_id: string;
	session_date: string;
	people: number;
	worker_ids: string[];
	held: HeldState;
};

export type GangDay = {
	session_date: string;
	people: number;
	held: HeldState;
	pumps: { pump_id: string; people: number; held: HeldState }[];
	workers: Set<string>;
};

// Folds per-pump rows into one row per gang and day: each worker once that day, held when any of
// its pumps is held that day (pending wins over rejected, as on screen).
export function foldGangDays(rows: GangPumpDay[]) {
	const byGang = new Map<string, Map<string, GangDay>>();
	for (const row of rows) {
		if (!byGang.has(row.gang_id)) byGang.set(row.gang_id, new Map());
		const days = byGang.get(row.gang_id)!;
		const day = days.get(row.session_date) ?? {
			session_date: row.session_date,
			people: 0,
			held: null,
			pumps: [],
			workers: new Set<string>()
		};
		for (const worker of row.worker_ids) day.workers.add(worker);
		day.people = day.workers.size;
		day.pumps.push({ pump_id: row.pump_id, people: row.people, held: row.held });
		if (row.held === 'pending' || (row.held === 'rejected' && day.held !== 'pending'))
			day.held = row.held;
		days.set(row.session_date, day);
	}
	return byGang;
}

export function gangLabel(gang: { code: number; name?: string | null }) {
	return gang.name ? `Gang ${gang.code} (${gang.name})` : `Gang ${gang.code}`;
}

// The Gangs list: every gang the viewer can see, by Area and the plant it last worked at.
export async function listGangs(viewer: GangViewer, url: URL) {
	const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
	const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const today = todayIST();
	const monthStart = `${today.slice(0, 7)}-01`;
	const gangs = await query<{
		id: string;
		code: number;
		name: string | null;
		area_name: string;
		created_at: string;
		first_pump_code: string | null;
		last_day: string | null;
		last_pump_code: string | null;
		last_plant_name: string | null;
		shifts: number;
		days_this_month: number;
		pumps_worked: number;
		faces: string[];
	}>(
		`SELECT g.id, g.code, g.name, a.name AS area_name, g.created_at,
		        fp.pump_code AS first_pump_code, last.session_date::text AS last_day,
		        lp.pump_code AS last_pump_code, lpl.name AS last_plant_name,
		        (SELECT count(*)::int FROM attendance_sessions s WHERE s.gang_id = g.id
		           AND s.session_type = 'morning' AND s.status IN ('review', 'completed')) AS shifts,
		        (SELECT count(DISTINCT s.session_date)::int FROM attendance_sessions s
		           WHERE s.gang_id = g.id AND s.status IN ('review', 'completed')
		             AND s.session_date >= $5) AS days_this_month,
		        (SELECT count(DISTINCT s.pump_id)::int FROM attendance_sessions s
		           WHERE s.gang_id = g.id AND s.status IN ('review', 'completed')) AS pumps_worked,
		        COALESCE((SELECT array_agg(f.id) FROM (
		          SELECT e.id FROM attendance_face_evidence e
		          WHERE e.session_id = COALESCE(last.id, g.source_session_id)
		            AND e.face_crop_url IS NOT NULL AND NOT e.is_operator
		          ORDER BY e.created_at LIMIT 5) f), '{}') AS faces
		 FROM gangs g JOIN areas a ON a.id = g.area_id
		 LEFT JOIN pumps fp ON fp.id = g.first_pump_id
		 LEFT JOIN LATERAL (SELECT s.id, s.pump_id, s.session_date FROM attendance_sessions s
		   WHERE s.gang_id = g.id AND s.status IN ('review', 'completed')
		   ORDER BY s.session_date DESC, s.submitted_at DESC LIMIT 1) last ON true
		 LEFT JOIN pumps lp ON lp.id = last.pump_id
		 LEFT JOIN plants lpl ON lpl.id = lp.plant_id
		 WHERE ${GANG_ALLOWED('g')}
		   AND ($3 = '' OR a.name ILIKE $4 OR lp.pump_code ILIKE $4 OR lpl.name ILIKE $4
		        OR fp.pump_code ILIKE $4 OR ('gang ' || g.code) ILIKE $4 OR g.name ILIKE $4)
		 ORDER BY a.name, lpl.name NULLS LAST, last.session_date DESC NULLS LAST, g.code`,
		[viewer.role, viewer.id, q, like, monthStart]
	);
	const linkQuestions = await openLinkQuestions(viewer);
	return { gangs, q, today, linkQuestions };
}

// One gang: its faces, members, and day by day (pump, headcount, start, end, ended near).
export async function loadGang(viewer: GangViewer, gangId: string, url: URL) {
	if (!UUID_PATTERN.test(gangId)) error(404, 'Gang not found');
	const gang = await queryOne<{
		id: string;
		code: number;
		name: string | null;
		area_id: string;
		area_name: string;
		created_at: string;
		source_session_id: string | null;
		first_pump_code: string | null;
	}>(
		`SELECT g.id, g.code, g.name, g.area_id, a.name AS area_name, g.created_at,
		        g.source_session_id, fp.pump_code AS first_pump_code
		 FROM gangs g JOIN areas a ON a.id = g.area_id LEFT JOIN pumps fp ON fp.id = g.first_pump_id
		 WHERE g.id = $3 AND ${GANG_ALLOWED('g')}`,
		[viewer.role, viewer.id, gangId]
	);
	if (!gang) error(404, 'Gang not found');

	const today = todayIST();
	const toParam = url.searchParams.get('to') ?? '';
	const to = isDateKey(toParam) && toParam <= today ? toParam : today;
	const fromParam = url.searchParams.get('from') ?? '';
	const from = isDateKey(fromParam) && fromParam <= to ? fromParam : addDaysStr(to, -29);

	// Members: the workers in its last five shifts, most shifts first, with their newest face. The
	// operator is one of them (counted in the headcount like on the pump sheet), labelled.
	const members = await query<{
		worker: string;
		operator: boolean;
		name: string | null;
		face_id: string | null;
		pump_code: string;
		last_day: string;
		shifts: number;
	}>(
		`WITH recent AS (
		   SELECT s.id FROM attendance_sessions s WHERE s.gang_id = $1
		     AND s.status IN ('review', 'completed')
		   ORDER BY s.submitted_at DESC LIMIT 5
		 ), seen AS (
		   SELECT COALESCE(p.area_worker_id, p.id) AS worker, p.name, e.id AS face_id,
		          pu.pump_code, s.session_date, s.submitted_at, e.face_crop_url IS NOT NULL AS has_face,
		          e.is_operator
		   FROM attendance_face_evidence e JOIN attendance_sessions s ON s.id = e.session_id
		   JOIN persons p ON p.id = e.person_id JOIN pumps pu ON pu.id = s.pump_id
		   WHERE s.gang_id = $1 AND s.status IN ('review', 'completed')
		 )
		 SELECT seen.worker::text AS worker, bool_or(seen.is_operator) AS operator,
		        (array_agg(seen.name ORDER BY seen.submitted_at DESC) FILTER (WHERE seen.name IS NOT NULL))[1] AS name,
		        (array_agg(seen.face_id::text ORDER BY seen.submitted_at DESC) FILTER (WHERE seen.has_face))[1] AS face_id,
		        (array_agg(seen.pump_code ORDER BY seen.submitted_at DESC))[1] AS pump_code,
		        max(seen.session_date)::text AS last_day, count(*)::int AS shifts
		 FROM seen
		 WHERE seen.worker IN (
		   SELECT COALESCE(p.area_worker_id, p.id) FROM attendance_face_evidence e
		   JOIN persons p ON p.id = e.person_id WHERE e.session_id IN (SELECT id FROM recent))
		 GROUP BY seen.worker ORDER BY count(*) DESC, max(seen.submitted_at) DESC`,
		[gangId]
	);

	// Day by day: each shift of the gang in the range with its pump, start, end and how it ended.
	const shifts = await query<{
		id: string;
		session_date: string;
		pump_id: string;
		pump_code: string;
		plant_name: string;
		started_at: string;
		start_location: string | null;
		pairing_status: string;
		closed_by: string | null;
		end_id: string | null;
		ended_at: string | null;
		people: number;
	}>(
		`SELECT st.id, st.session_date::text AS session_date, st.pump_id, pu.pump_code,
		        pl.name AS plant_name, st.submitted_at AS started_at, st.location_status AS start_location,
		        st.pairing_status, st.closed_by, en.id AS end_id, en.submitted_at AS ended_at,
		        (SELECT count(DISTINCT e.person_id)::int FROM attendance_face_evidence e
		           WHERE e.session_id IN (st.id, en.id)) AS people
		 FROM attendance_sessions st JOIN pumps pu ON pu.id = st.pump_id
		 JOIN plants pl ON pl.id = pu.plant_id
		 LEFT JOIN attendance_sessions en ON en.session_type = 'evening' AND en.paired_session_id = st.id
		   AND en.status IN ('review', 'completed')
		 WHERE st.gang_id = $3 AND st.session_type = 'morning' AND st.status IN ('review', 'completed')
		   AND st.session_date BETWEEN $4 AND $5 AND ${PUMP_ALLOWED('pu')}
		 ORDER BY st.session_date DESC, st.submitted_at DESC`,
		[viewer.role, viewer.id, gangId, from, to]
	);

	const rows = await query<GangPumpDay>(
		gangDaySql(
			`EXISTS (SELECT 1 FROM attendance_sessions gs WHERE gs.pump_id = pu.id AND gs.gang_id = $3) AND ${PUMP_ALLOWED('pu')}`,
			4
		),
		[viewer.role, viewer.id, gangId, from, to]
	);
	const days = foldGangDays(rows.filter((row) => row.gang_id === gangId)).get(gangId);
	const headcount = new Map([...(days?.values() ?? [])].map((day) => [day.session_date, day]));

	// Other gangs of the Area a shift can be moved to.
	const otherGangs = await query<{ id: string; code: number; name: string | null }>(
		`SELECT g.id, g.code, g.name FROM gangs g WHERE g.area_id = $1 AND g.id <> $2 ORDER BY g.code`,
		[gang.area_id, gangId]
	);

	const counted = [...headcount.values()].filter((day) => !day.held);
	return {
		gang,
		members,
		shifts: shifts.map((shift) => ({
			...shift,
			headcount: headcount.get(shift.session_date)?.people ?? 0,
			held: headcount.get(shift.session_date)?.held ?? null
		})),
		otherGangs,
		range: { from, to, today },
		summary: {
			days: counted.length,
			average: counted.length
				? Math.round((counted.reduce((n, day) => n + day.people, 0) / counted.length) * 10) / 10
				: null,
			pumps: new Set(shifts.map((shift) => shift.pump_id)).size
		}
	};
}

// Moves one shift (its start and its paired end) to another gang of the same Area, or to a new
// gang; logged. The faces stay where they are; only the gang a shift counts for changes.
export async function moveShiftGang(viewer: GangViewer, form: FormData) {
	const sessionId = String(form.get('shift') || '');
	const target = String(form.get('gang') || '');
	if (!UUID_PATTERN.test(sessionId) || !(target === 'new' || UUID_PATTERN.test(target)))
		return fail(400, { formKind: 'move', message: 'Choose the gang to move this shift to.' });
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const { rows } = await client.query(
			`SELECT st.id, st.gang_id, st.pump_id, st.session_date::text AS session_date, g.area_id,
			        g.code AS from_code, pu.pump_code
			 FROM attendance_sessions st JOIN gangs g ON g.id = st.gang_id
			 JOIN pumps pu ON pu.id = st.pump_id
			 WHERE st.id = $3 AND st.session_type = 'morning' AND ${PUMP_ALLOWED('pu')}
			 FOR UPDATE OF st`,
			[viewer.role, viewer.id, sessionId]
		);
		const shift = rows[0];
		if (!shift) {
			await client.query('ROLLBACK');
			return fail(404, { formKind: 'move', message: 'Shift not found.' });
		}
		let gangId = target;
		let toCode: number;
		if (target === 'new') {
			const made = await client.query(
				`INSERT INTO gangs (area_id, code, source_session_id, first_pump_id)
				 VALUES ($1, (SELECT COALESCE(MAX(code), 0) + 1 FROM gangs WHERE area_id = $1), $2, $3)
				 RETURNING id, code`,
				[shift.area_id, shift.id, shift.pump_id]
			);
			gangId = made.rows[0].id;
			toCode = made.rows[0].code;
		} else {
			const found = await client.query('SELECT code FROM gangs WHERE id = $1 AND area_id = $2', [
				target,
				shift.area_id
			]);
			if (!found.rows[0] || target === shift.gang_id) {
				await client.query('ROLLBACK');
				return fail(400, { formKind: 'move', message: 'Choose another gang of this Area.' });
			}
			toCode = found.rows[0].code;
		}
		await client.query(
			`UPDATE attendance_sessions SET gang_id = $2
			 WHERE id = $1 OR (session_type = 'evening' AND paired_session_id = $1)`,
			[shift.id, gangId]
		);
		await client.query(
			`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
			 VALUES ($1, 'move_shift_gang', 'attendance_session', $2, $3)`,
			[
				viewer.role === 'admin' ? viewer.id : null,
				shift.id,
				JSON.stringify({
					pump: shift.pump_code,
					day: shift.session_date,
					from_gang: shift.from_code,
					to_gang: toCode,
					by: viewer
				})
			]
		);
		await client.query('COMMIT');
		return {
			formKind: 'move',
			success: true,
			message: `Moved. The ${shift.pump_code} shift of ${shift.session_date} now counts for Gang ${toCode}.`,
			movedTo: gangId
		};
	} catch (moveError) {
		await client.query('ROLLBACK').catch(() => {});
		logger.error({ sessionId, error: String(moveError) }, 'move shift gang failed');
		return fail(500, { formKind: 'move', message: 'Could not move the shift. Nothing changed.' });
	} finally {
		client.release();
	}
}

// "Same person?": a new worker whose face was a close call with a worker at another pump of the
// Area. Asked side by side; never linked by itself.
export async function openLinkQuestions(viewer: GangViewer) {
	return query<{
		id: string;
		similarity: number;
		new_person: string;
		new_name: string | null;
		new_pump: string;
		new_face: string | null;
		other_person: string;
		other_name: string | null;
		other_pump: string;
		other_face: string | null;
		created_at: string;
	}>(
		`SELECT c.id, c.similarity, c.created_at,
		        np.id AS new_person, np.name AS new_name, npu.pump_code AS new_pump,
		        (SELECT e.id FROM attendance_face_evidence e WHERE e.person_id = np.id
		           AND e.face_crop_url IS NOT NULL ORDER BY e.created_at DESC LIMIT 1) AS new_face,
		        op.id AS other_person, op.name AS other_name, opu.pump_code AS other_pump,
		        (SELECT e.id FROM attendance_face_evidence e WHERE e.person_id = op.id
		           AND e.face_crop_url IS NOT NULL ORDER BY e.created_at DESC LIMIT 1) AS other_face
		 FROM worker_link_candidates c
		 JOIN persons np ON np.id = c.person_id JOIN pumps npu ON npu.id = np.pump_id
		 JOIN persons op ON op.id = c.other_person_id JOIN pumps opu ON opu.id = op.pump_id
		 WHERE c.status = 'open' AND np.status = 'active' AND op.status = 'active'
		   AND ${PUMP_ALLOWED('npu')}
		 ORDER BY c.created_at
		 LIMIT 50`,
		[viewer.role, viewer.id]
	);
}

// Answers one "Same person?": Same links the new worker to the other one (one worker across the
// pumps, the name follows); Different closes it. Logged.
export async function decideLink(viewer: GangViewer, form: FormData) {
	const candidateId = String(form.get('candidate') || '');
	const answer = String(form.get('answer') || '');
	if (!UUID_PATTERN.test(candidateId) || !['same', 'different'].includes(answer))
		return fail(400, { formKind: 'link', message: 'Choose Same person or Different people.' });
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const { rows } = await client.query(
			`SELECT c.id, c.person_id, c.other_person_id, np.area_worker_id AS new_worker,
			        op.area_worker_id AS other_worker, op.name AS other_name, pl.area_id
			 FROM worker_link_candidates c
			 JOIN persons np ON np.id = c.person_id JOIN pumps pu ON pu.id = np.pump_id
			 JOIN plants pl ON pl.id = pu.plant_id
			 JOIN persons op ON op.id = c.other_person_id
			 WHERE c.id = $3 AND c.status = 'open' AND ${PUMP_ALLOWED('pu')}
			 FOR UPDATE OF c`,
			[viewer.role, viewer.id, candidateId]
		);
		const candidate = rows[0];
		if (!candidate) {
			await client.query('ROLLBACK');
			return fail(404, { formKind: 'link', message: 'This question was already answered.' });
		}
		if (answer === 'same') {
			let worker = candidate.other_worker;
			if (!worker) {
				const made = await client.query(
					'INSERT INTO area_workers (area_id) VALUES ($1) RETURNING id',
					[candidate.area_id]
				);
				worker = made.rows[0].id;
				await client.query('UPDATE persons SET area_worker_id = $2 WHERE id = $1', [
					candidate.other_person_id,
					worker
				]);
			}
			// Everyone already linked to the new worker joins too.
			if (candidate.new_worker && candidate.new_worker !== worker)
				await client.query('UPDATE persons SET area_worker_id = $2 WHERE area_worker_id = $1', [
					candidate.new_worker,
					worker
				]);
			await client.query(
				'UPDATE persons SET area_worker_id = $2, name = COALESCE(name, $3) WHERE id = $1',
				[candidate.person_id, worker, candidate.other_name]
			);
		}
		await client.query(
			`UPDATE worker_link_candidates SET status = $2, decided_by_role = $3, decided_by_id = $4,
			   decided_at = now() WHERE id = $1`,
			[candidateId, answer === 'same' ? 'linked' : 'different', viewer.role, viewer.id]
		);
		await client.query(
			`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
			 VALUES ($1, 'decide_worker_link', 'person', $2, $3)`,
			[
				viewer.role === 'admin' ? viewer.id : null,
				candidate.person_id,
				JSON.stringify({ answer, other: candidate.other_person_id, by: viewer })
			]
		);
		await client.query('COMMIT');
		return {
			formKind: 'link',
			success: true,
			message:
				answer === 'same'
					? 'Saved. They are one worker across the pumps now.'
					: 'Saved. They stay two different workers.'
		};
	} catch (linkError) {
		await client.query('ROLLBACK').catch(() => {});
		logger.error({ candidateId, error: String(linkError) }, 'worker link decision failed');
		return fail(500, { formKind: 'link', message: 'Could not save. Nothing changed.' });
	} finally {
		client.release();
	}
}

// The By gang view of the Attendance pages: gang x day headcount for the pumps a condition allows
// (over pu, pl, a, v with the given params), with the gang's label and where it last worked.
export async function gangGrid(pumpWhere: string, params: unknown[], from: string, to: string) {
	const rows = await query<GangPumpDay>(gangDaySql(pumpWhere, params.length + 1), [
		...params,
		from,
		to
	]);
	if (!rows.length) return null;
	const byGang = foldGangDays(rows);
	const gangs = await query<{
		id: string;
		code: number;
		name: string | null;
		area_name: string;
		last_pump: string | null;
	}>(
		`SELECT g.id, g.code, g.name, a.name AS area_name,
		        (SELECT pu.pump_code FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
		         WHERE s.gang_id = g.id AND s.session_date <= $2
		         ORDER BY s.session_date DESC, s.submitted_at DESC LIMIT 1) AS last_pump
		 FROM gangs g JOIN areas a ON a.id = g.area_id WHERE g.id = ANY($1::uuid[])
		 ORDER BY a.name, g.code`,
		[[...byGang.keys()], to]
	);
	const cells: Record<string, { people: number; held: HeldState }> = {};
	const dayWorkers = new Map<string, Set<string>>();
	for (const [gangId, days] of byGang)
		for (const day of days.values()) {
			cells[`${gangId}|${day.session_date}`] = { people: day.people, held: day.held };
			if (day.held) continue;
			const set = dayWorkers.get(day.session_date) ?? new Set<string>();
			for (const worker of day.workers) set.add(worker);
			dayWorkers.set(day.session_date, set);
		}
	return {
		gangs: gangs.map((gang) => ({
			id: gang.id,
			label: `${gangLabel(gang)}${gang.last_pump ? `, last ${gang.last_pump}` : ''}`,
			area_name: gang.area_name
		})),
		cells,
		dayTotals: Object.fromEntries([...dayWorkers].map(([day, set]) => [day, set.size]))
	};
}
