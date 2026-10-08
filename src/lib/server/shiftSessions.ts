import type { Pool, PoolClient } from 'pg';

// Shift sessions. The database keeps session_type 'morning' for the shift start photo and
// 'evening' for the shift end photo (the UI says Shift start / Shift end). One shift per pump per
// session_date; the end inherits the start's date.
//
// A start stops waiting for its end in one of three ways, recorded in closed_by:
//   pump    - the operator pressed End session (allowed once the evening gap has passed)
//   timeout - nothing came within the pairing window (lazy check on submit/today + worker sweep)
//   admin   - an admin fix on /admin/pumps/[id]
// Closing a start finalizes the day: workers seen only at the start count as "start only".

type Db = Pool | PoolClient;
type RollupColumn = 'days_present' | 'days_morning_only' | 'days_evening_only';

export class ShiftError extends Error {}

// SQL condition: the shift for this daily_person_attendance row's pump and date is still open.
// A start-only day is only start only once the shift is closed; until then it is in progress.
// `dpa` is the alias (or table name) of daily_person_attendance in the calling query.
export function shiftStillOpen(dpa: string) {
	return `EXISTS (SELECT 1 FROM attendance_sessions open_start
	         WHERE open_start.pump_id = ${dpa}.pump_id AND open_start.session_date = ${dpa}.session_date
	           AND open_start.session_type = 'morning' AND open_start.pairing_status = 'open')`;
}

// Shared tail of every "close these starts" statement. `closed` must return id, pump_id,
// session_date. Rollups go to days_morning_only for workers with no end match that day.
const FINALIZE_CLOSED_STARTS = `
 finalized AS (
   INSERT INTO attendance_rollup_finalizations (pump_id, session_date, session_id)
   SELECT pump_id, session_date, id FROM closed
   ON CONFLICT (pump_id, session_date) DO NOTHING
   RETURNING pump_id, session_date
 ),
 yearly AS (
   INSERT INTO person_attendance_yearly (person_id, year, days_morning_only)
   SELECT dpa.person_id, EXTRACT(YEAR FROM dpa.session_date)::int, 1
   FROM daily_person_attendance dpa
   JOIN finalized f ON f.pump_id = dpa.pump_id AND f.session_date = dpa.session_date
   WHERE dpa.morning_matched AND NOT dpa.evening_matched
   ON CONFLICT (person_id, year)
   DO UPDATE SET days_morning_only = person_attendance_yearly.days_morning_only + 1,
                 last_updated = now()
 )
 SELECT id FROM closed`;

// Auto-close: open, completed starts of this pump older than the pairing window.
// worker/index.js runs the same statement for every pump on its hourly sweep.
export async function expireStaleStarts(db: Db, pumpId: string, windowHours: number) {
	const { rowCount } = await db.query(
		`WITH closed AS (
		   UPDATE attendance_sessions
		   SET pairing_status = 'expired', closed_by = 'timeout', closed_at = now()
		   WHERE pump_id = $1 AND session_type = 'morning' AND status = 'completed'
		     AND pairing_status = 'open'
		     AND now() - submitted_at > ($2 || ' hours')::interval
		   RETURNING id, pump_id, session_date
		 ),${FINALIZE_CLOSED_STARTS}`,
		[pumpId, windowHours]
	);
	return rowCount ?? 0;
}

async function closeStart(client: PoolClient, sessionId: string, closedBy: 'pump' | 'admin') {
	const { rowCount } = await client.query(
		`WITH closed AS (
		   UPDATE attendance_sessions
		   SET pairing_status = 'expired', closed_by = $2, closed_at = now()
		   WHERE id = $1 AND session_type = 'morning' AND status = 'completed'
		     AND pairing_status = 'open'
		   RETURNING id, pump_id, session_date
		 ),${FINALIZE_CLOSED_STARTS}`,
		[sessionId, closedBy]
	);
	if (!rowCount) throw new ShiftError('This shift is no longer open.');
}

function formatWait(minutes: number) {
	const remaining = Math.max(1, Math.ceil(minutes));
	const hours = Math.floor(remaining / 60);
	return hours ? `${hours} h ${remaining % 60} min` : `${remaining} min`;
}

export function shiftEndOpensMessage(remainingMinutes: number) {
	return `Shift end opens in ${formatWait(remainingMinutes)}.`;
}

// Pump's End session button: closes its open start without an end photo.
export async function pumpEndShift(client: PoolClient, pumpId: string, gapMinutes: number) {
	const { rows } = await client.query(
		`SELECT id, status, EXTRACT(EPOCH FROM (now() - submitted_at)) / 60 AS elapsed_minutes
		 FROM attendance_sessions
		 WHERE pump_id = $1 AND session_type = 'morning' AND pairing_status = 'open'
		 ORDER BY submitted_at DESC LIMIT 1
		 FOR UPDATE`,
		[pumpId]
	);
	const start = rows[0];
	if (!start) throw new ShiftError('There is no open shift to end.');
	if (start.status !== 'completed') {
		throw new ShiftError('Finish reviewing the shift start photo first.');
	}
	const elapsed = Number(start.elapsed_minutes);
	if (elapsed < gapMinutes) throw new ShiftError(shiftEndOpensMessage(gapMinutes - elapsed));
	await closeStart(client, start.id, 'pump');
	return start.id as string;
}

// --- Admin fixes -------------------------------------------------------------------------

type SessionRow = {
	id: string;
	pump_id: string;
	session_date: string;
	session_type: 'morning' | 'evening';
	status: string;
	pairing_status: 'open' | 'paired' | 'expired';
	paired_session_id: string | null;
	submitted_at: Date;
	ist_submitted_date: string;
	age_hours: number;
};

async function lockSession(client: PoolClient, pumpId: string, sessionId: string) {
	const { rows } = await client.query<SessionRow>(
		`SELECT id, pump_id, session_date::text AS session_date, session_type, status,
		        pairing_status, paired_session_id, submitted_at,
		        (submitted_at AT TIME ZONE 'Asia/Kolkata')::date::text AS ist_submitted_date,
		        EXTRACT(EPOCH FROM (now() - submitted_at)) / 3600 AS age_hours
		 FROM attendance_sessions WHERE id = $1 AND pump_id = $2
		 FOR UPDATE`,
		[sessionId, pumpId]
	);
	if (!rows[0]) throw new ShiftError('Session not found for this pump.');
	return rows[0];
}

async function rollupSnapshot(client: PoolClient, pumpId: string, dates: string[]) {
	const { rows } = await client.query<{
		person_id: string;
		year: number;
		rollup_column: RollupColumn | null;
	}>(
		`SELECT dpa.person_id, EXTRACT(YEAR FROM dpa.session_date)::int AS year,
		        CASE
		          WHEN dpa.morning_matched AND dpa.evening_matched THEN 'days_present'
		          WHEN dpa.morning_matched THEN 'days_morning_only'
		          WHEN dpa.evening_matched THEN 'days_evening_only'
		        END AS rollup_column
		 FROM daily_person_attendance dpa
		 JOIN attendance_rollup_finalizations f
		   ON f.pump_id = dpa.pump_id AND f.session_date = dpa.session_date
		 WHERE dpa.pump_id = $1 AND dpa.session_date = ANY($2::date[])`,
		[pumpId, dates]
	);
	return rows;
}

// Runs a change to sessions/daily attendance on the given dates and then corrects the yearly
// roll-up by the difference: what was counted for finalized days before, versus what should be
// counted after. Every date the change touches must be listed.
async function withRollupSync<T>(
	client: PoolClient,
	pumpId: string,
	dates: string[],
	change: () => Promise<T>
): Promise<T> {
	const before = await rollupSnapshot(client, pumpId, dates);
	const result = await change();
	const after = await rollupSnapshot(client, pumpId, dates);

	const delta = new Map<
		string,
		{ personId: string; year: number; column: RollupColumn; n: number }
	>();
	const add = (row: (typeof before)[number], n: number) => {
		if (!row.rollup_column) return;
		const key = `${row.person_id}|${row.year}|${row.rollup_column}`;
		const entry = delta.get(key) ?? {
			personId: row.person_id,
			year: row.year,
			column: row.rollup_column,
			n: 0
		};
		entry.n += n;
		delta.set(key, entry);
	};
	before.forEach((row) => add(row, -1));
	after.forEach((row) => add(row, 1));

	for (const { personId, year, column, n } of delta.values()) {
		if (!n) continue;
		await client.query(
			`INSERT INTO person_attendance_yearly (person_id, year, ${column})
			 VALUES ($1, $2, GREATEST($3::int, 0))
			 ON CONFLICT (person_id, year)
			 DO UPDATE SET ${column} = GREATEST(person_attendance_yearly.${column} + $3::int, 0),
			               last_updated = now()`,
			[personId, year, n]
		);
	}
	return result;
}

async function finalizeDay(client: PoolClient, pumpId: string, date: string, sessionId: string) {
	await client.query(
		`INSERT INTO attendance_rollup_finalizations (pump_id, session_date, session_id)
		 VALUES ($1, $2, $3) ON CONFLICT (pump_id, session_date) DO NOTHING`,
		[pumpId, date, sessionId]
	);
}

// Admin "End session": same as the pump button, without the 9 h wait.
export async function adminEndShift(client: PoolClient, pumpId: string, sessionId: string) {
	const session = await lockSession(client, pumpId, sessionId);
	if (session.session_type !== 'morning' || session.pairing_status !== 'open') {
		throw new ShiftError('Only an open shift start can be ended.');
	}
	if (session.status !== 'completed') {
		throw new ShiftError('This shift start is still being processed or reviewed.');
	}
	await closeStart(client, session.id, 'admin');
	return { sessionId: session.id, sessionDate: session.session_date };
}

// Admin "Split": a forgotten end made the next shift's start photo count as this shift's end.
// The old start closes as "start only" and the photo becomes a new start, dated by the day it
// was taken (IST). Attendance from the photo moves from "end" on the old date to "start" on the
// new date; no faces are re-matched.
export async function splitEndIntoStart(
	client: PoolClient,
	pumpId: string,
	sessionId: string,
	windowHours: number
) {
	const end = await lockSession(client, pumpId, sessionId);
	if (end.session_type !== 'evening') throw new ShiftError('Only a shift end can be split.');
	const start = end.paired_session_id
		? await lockSession(client, pumpId, end.paired_session_id)
		: null;
	const oldDate = end.session_date;
	const newDate = end.ist_submitted_date;

	const clash = await client.query(
		`SELECT 1 FROM attendance_sessions
		 WHERE pump_id = $1 AND session_date = $2 AND session_type = 'morning'`,
		[pumpId, newDate]
	);
	if (clash.rowCount) {
		throw new ShiftError(
			`A shift start already exists on ${newDate}, the day this photo was taken. Move that shift to another date first.`
		);
	}
	// Compared in SQL: a JS Date drops Postgres microseconds, so the photo would look later
	// than itself.
	const later = await client.query(
		`SELECT 1 FROM attendance_sessions
		 WHERE pump_id = $1 AND id <> $2
		   AND submitted_at > (SELECT submitted_at FROM attendance_sessions WHERE id = $2)
		 LIMIT 1`,
		[pumpId, end.id]
	);
	// The new start can still wait for its own end only if it is the pump's latest photo and
	// is inside the pairing window; otherwise it is closed as "start only" straight away.
	const stayOpen = !later.rowCount && Number(end.age_hours) < windowHours;

	await withRollupSync(client, pumpId, [oldDate, newDate], async () => {
		if (start) {
			await client.query(
				`UPDATE attendance_sessions
				 SET pairing_status = 'expired', paired_session_id = NULL, closed_by = 'admin', closed_at = now()
				 WHERE id = $1`,
				[start.id]
			);
			if (start.status === 'completed') await finalizeDay(client, pumpId, oldDate, start.id);
		}

		const { rows: people } = await client.query<{ person_id: string; match_confidence: number }>(
			'SELECT person_id, match_confidence FROM attendance_face_evidence WHERE session_id = $1',
			[end.id]
		);
		const personIds = people.map((row) => row.person_id);
		if (personIds.length) {
			await client.query(
				`UPDATE daily_person_attendance
				 SET evening_matched = false, evening_confidence = NULL, updated_at = now()
				 WHERE pump_id = $1 AND session_date = $2 AND person_id = ANY($3::uuid[])`,
				[pumpId, oldDate, personIds]
			);
			await client.query(
				`DELETE FROM daily_person_attendance
				 WHERE pump_id = $1 AND session_date = $2 AND person_id = ANY($3::uuid[])
				   AND NOT morning_matched AND NOT evening_matched`,
				[pumpId, oldDate, personIds]
			);
		}

		await client.query(
			`UPDATE attendance_sessions
			 SET session_type = 'morning', session_date = $2, paired_session_id = NULL,
			     pairing_status = $3, closed_by = $4, closed_at = $5
			 WHERE id = $1`,
			[
				end.id,
				newDate,
				stayOpen ? 'open' : 'expired',
				stayOpen ? null : 'admin',
				stayOpen ? null : new Date()
			]
		);
		for (const person of people) {
			await client.query(
				`INSERT INTO daily_person_attendance
				   (person_id, pump_id, session_date, morning_matched, morning_confidence)
				 VALUES ($1, $2, $3, true, $4)
				 ON CONFLICT (person_id, session_date)
				 DO UPDATE SET morning_matched = true, morning_confidence = $4, updated_at = now()`,
				[person.person_id, pumpId, newDate, person.match_confidence]
			);
		}
		if (!stayOpen && end.status === 'completed') {
			await finalizeDay(client, pumpId, newDate, end.id);
		}
	});

	return {
		oldStartId: start?.id ?? null,
		newStartId: end.id,
		fromDate: oldDate,
		toDate: newDate,
		newStartOpen: stayOpen
	};
}

// Admin "Move to date": moves a whole shift (start and its end) and that day's attendance to
// another date, e.g. a start filed on the wrong day. The target date must have no shift.
export async function moveShiftDate(
	client: PoolClient,
	pumpId: string,
	sessionId: string,
	newDate: string,
	today: string
) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate) || Number.isNaN(Date.parse(newDate))) {
		throw new ShiftError('Choose a valid date.');
	}
	if (newDate > today) throw new ShiftError('A shift cannot be moved to a future date.');
	const session = await lockSession(client, pumpId, sessionId);
	const other = session.paired_session_id
		? await lockSession(client, pumpId, session.paired_session_id)
		: null;
	const oldDate = session.session_date;
	if (newDate === oldDate) throw new ShiftError('The shift is already on that date.');

	const clash = await client.query(
		'SELECT 1 FROM attendance_sessions WHERE pump_id = $1 AND session_date = $2',
		[pumpId, newDate]
	);
	if (clash.rowCount) {
		throw new ShiftError(`This pump already has a shift on ${newDate}. Move or delete it first.`);
	}
	const leftovers = await client.query(
		'SELECT 1 FROM daily_person_attendance WHERE pump_id = $1 AND session_date = $2 LIMIT 1',
		[pumpId, newDate]
	);
	if (leftovers.rowCount) {
		throw new ShiftError(
			`Attendance already exists on ${newDate} from a manual correction. Clear it first.`
		);
	}

	const ids = [session.id, ...(other ? [other.id] : [])];
	await withRollupSync(client, pumpId, [oldDate, newDate], async () => {
		await client.query(
			'UPDATE attendance_sessions SET session_date = $2 WHERE id = ANY($1::uuid[])',
			[ids, newDate]
		);
		for (const table of [
			'daily_person_attendance',
			'attendance_rollup_finalizations',
			'attendance_corrections',
			'attendance_duplicate_resolutions'
		]) {
			await client.query(
				`UPDATE ${table} SET session_date = $3 WHERE pump_id = $1 AND session_date = $2`,
				[pumpId, oldDate, newDate]
			);
		}
	});
	return { sessionIds: ids, fromDate: oldDate, toDate: newDate };
}
