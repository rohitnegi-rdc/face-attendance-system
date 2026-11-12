// The one rule for what a day is on the regularisation calendar and whether it can be applied for.
// The month view and the apply check both read it, so they can never disagree.
//   full         everyone counted has a start and an end
//   partial      a worker has only a start or only an end (light red, Apply)
//   missed       the pump was Active or Idle and no photo came (dark red, Apply)
//   waiting      a request is waiting for approval
//   regularised  a request was approved
//   rejected     the latest request was rejected, and the day can be applied for again
//   none         nothing to do: Inactive, today, a future day, a shift still open, photos in checking
// Everything is a date string in India time, computed in code.
import type { Pool, PoolClient } from 'pg';
import { pool } from './db';
import { todayIST } from './time';

export type DayState =
	| 'full'
	| 'partial'
	| 'missed'
	| 'waiting'
	| 'regularised'
	| 'rejected'
	| 'none';
export type DayNote = 'inactive' | 'today' | 'future' | 'open' | 'checking';

export type CalendarDay = {
	day: string;
	state: DayState;
	note: DayNote | null;
	canApply: boolean;
	kind: 'missed' | 'partial' | null;
	counted: string[];
	request: {
		id: string;
		status: 'pending' | 'approved' | 'rejected';
		decisionReason: string | null;
		decidedByName: string | null;
		decidedAt: string | null;
	} | null;
};

export type CalendarMonth = {
	month: string;
	minMonth: string;
	maxMonth: string;
	days: CalendarDay[];
};

type DayRow = {
	day: string;
	pump_status: string | null;
	rows_any: number;
	people: number;
	halves: number;
	counted: string[];
	photos: number;
	open_shift: boolean;
	busy: boolean;
	request_id: string | null;
	request_status: string | null;
	decision_reason: string | null;
	decided_by_name: string | null;
	decided_at_label: string | null;
};

// $1 pump, $2 first day, $3 last day. `decided_at_label` is India time, written the way people read.
const DAYS_SQL = `
	SELECT to_char(d, 'YYYY-MM-DD') AS day,
	       st.status AS pump_status,
	       COALESCE(c.rows_any, 0)::int AS rows_any,
	       COALESCE(c.people, 0)::int AS people,
	       COALESCE(c.halves, 0)::int AS halves,
	       COALESCE(c.counted, ARRAY[]::text[]) AS counted,
	       COALESCE(s.photos, 0)::int AS photos,
	       COALESCE(s.open_shift, false) AS open_shift,
	       COALESCE(s.busy, false) AS busy,
	       rq.id AS request_id, rq.status AS request_status, rq.decision_reason, rq.decided_by_name,
	       to_char(rq.decided_at AT TIME ZONE 'Asia/Kolkata', 'Dy, FMDD Mon YYYY, FMHH12:MI am')
	         AS decided_at_label
	FROM generate_series($2::date::timestamp, $3::date::timestamp, interval '1 day') d
	LEFT JOIN LATERAL (
	  SELECT s.status FROM pump_day_status s
	  WHERE s.pump_id = $1 AND s.day <= d::date ORDER BY s.day DESC LIMIT 1
	) st ON true
	LEFT JOIN LATERAL (
	  SELECT count(*) AS rows_any,
	         count(*) FILTER (WHERE p.status IN ('active', 'pending_review')
	                            AND (a.morning_matched OR a.evening_matched)) AS people,
	         count(*) FILTER (WHERE p.status IN ('active', 'pending_review')
	                            AND a.morning_matched <> a.evening_matched) AS halves,
	         array_agg(COALESCE(NULLIF(p.name, ''), 'Worker ' || p.display_seq)
	                   || CASE WHEN a.morning_matched AND NOT a.evening_matched THEN ' (start only)'
	                           WHEN a.evening_matched AND NOT a.morning_matched THEN ' (end only)'
	                           ELSE '' END
	                   ORDER BY p.display_seq)
	           FILTER (WHERE p.status IN ('active', 'pending_review')
	                     AND (a.morning_matched OR a.evening_matched)) AS counted
	  FROM daily_person_attendance a JOIN persons p ON p.id = a.person_id
	  WHERE a.pump_id = $1 AND a.session_date = d::date
	) c ON true
	LEFT JOIN LATERAL (
	  SELECT count(*) AS photos,
	         bool_or(s.session_type = 'morning' AND s.pairing_status = 'open') AS open_shift,
	         bool_or(s.status IN ('pending', 'processing')) AS busy
	  FROM attendance_sessions s
	  WHERE s.pump_id = $1 AND s.session_date = d::date AND s.status <> 'failed'
	) s ON true
	LEFT JOIN LATERAL (
	  SELECT r.id, r.status, r.decision_reason, r.decided_by_name, r.decided_at
	  FROM regularisations r
	  WHERE r.pump_id = $1 AND r.day = d::date ORDER BY r.requested_at DESC LIMIT 1
	) rq ON true
	ORDER BY d`;

function classify(
	row: DayRow,
	today: string
): Pick<CalendarDay, 'state' | 'note' | 'canApply' | 'kind'> {
	const none = (note: DayNote | null) =>
		({ state: 'none', note, canApply: false, kind: null }) as const;
	const settled = (state: DayState) => ({ state, note: null, canApply: false, kind: null });
	if (row.day > today) return none('future');
	if (row.day === today) return none('today');
	if (row.request_status === 'pending') return settled('waiting');
	if (row.request_status === 'approved') return settled('regularised');
	// A start that can still get its end: the shift is not over, so nothing is missing yet.
	if (row.open_shift) return none('open');
	if (row.busy) return none('checking');

	const worked = row.pump_status === 'active' || row.pump_status === 'idle';
	const kind =
		worked && row.halves > 0
			? 'partial'
			: worked && row.photos === 0 && row.rows_any === 0
				? 'missed'
				: null;
	if (kind) {
		const state = row.request_status === 'rejected' ? 'rejected' : kind;
		return { state, note: null, canApply: true, kind };
	}
	if (row.people > 0 && row.halves === 0) return settled('full');
	return none(row.photos > 0 ? 'checking' : 'inactive');
}

function toDay(row: DayRow, today: string): CalendarDay {
	const status = row.request_status;
	const shown = status === 'pending' || status === 'approved' || status === 'rejected';
	return {
		day: row.day,
		...classify(row, today),
		counted: row.counted,
		request: shown
			? {
					id: row.request_id!,
					status,
					decisionReason: row.decision_reason,
					decidedByName: row.decided_by_name,
					decidedAt: row.decided_at_label
				}
			: null
	};
}

// One day of one pump. Pass the open transaction when checking inside one.
export async function dayInfo(
	db: Pool | PoolClient,
	pumpId: string,
	day: string
): Promise<CalendarDay> {
	const { rows } = await db.query<DayRow>(DAYS_SQL, [pumpId, day, day]);
	return toDay(rows[0], todayIST());
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

// A month of one pump, from its first status or attendance up to this month. Null if out of range.
export async function pumpMonth(pumpId: string, month: string): Promise<CalendarMonth | null> {
	const match = MONTH.exec(month);
	if (!match) return null;
	const today = todayIST();
	const maxMonth = today.slice(0, 7);
	const { rows: first } = await pool.query<{ first_day: string | null }>(
		`SELECT to_char(LEAST(
		   (SELECT min(day) FROM pump_day_status WHERE pump_id = $1),
		   (SELECT min(session_date) FROM daily_person_attendance WHERE pump_id = $1)
		 ), 'YYYY-MM-DD') AS first_day`,
		[pumpId]
	);
	const minMonth = first[0]?.first_day?.slice(0, 7) ?? maxMonth;
	if (month > maxMonth || month < minMonth) return null;
	const year = Number(match[1]);
	const number = Number(match[2]);
	const lastDay = new Date(Date.UTC(year, number, 0)).getUTCDate();
	const { rows } = await pool.query<DayRow>(DAYS_SQL, [
		pumpId,
		`${month}-01`,
		`${month}-${String(lastDay).padStart(2, '0')}`
	]);
	return { month, minMonth, maxMonth, days: rows.map((row) => toDay(row, today)) };
}
