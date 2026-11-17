// Day by day for one pump: what it sent on each calendar day (India time), whatever shift the
// photo counted for. Answers "did this pump send attendance on day X" without server commands:
// a night shift's end photo sent on the 16th counts for the 15th, and a refused photo is never
// saved as a session, only logged (system_logs, kept LOG_RETENTION_DAYS).
import { query } from '$lib/server/db';
import { daysBetween } from '$lib/date';
import type { PumpWorkStatus } from '$lib/pumpWorkStatus';

export type DiaryEvent =
	| {
			kind: 'photo';
			at: string;
			shift: 'morning' | 'evening';
			countedFor: string;
			status: string;
			pairing: string;
			error: string | null;
			testMode: boolean;
	  }
	| { kind: 'closed'; at: string; countedFor: string; by: 'pump' | 'timeout' | 'admin' }
	| { kind: 'refused'; at: string; reason: string };

export type DiaryDay = {
	day: string;
	status: PumpWorkStatus;
	siteName: string | null;
	events: DiaryEvent[];
};

const REFUSAL_MESSAGES = ['attendance submission rejected', 'attendance submission failed'];

// Placed on the India day it happened, whatever the server clock: [from 00:00 IST, to+1 00:00 IST).
const inRange = (col: string) =>
	`${col} >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
	 AND ${col} < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;
const istDay = (col: string) => `to_char(${col} AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`;

export async function pumpDiary(pumpId: string, from: string, to: string): Promise<DiaryDay[]> {
	const [statuses, photos, closed, refused] = await Promise.all([
		// The status in force that day: the latest row on or before it; no row is Inactive.
		query<{ day: string; status: PumpWorkStatus | null; site_name: string | null }>(
			`SELECT to_char(d, 'YYYY-MM-DD') AS day, st.status, st.site_name
			 FROM generate_series($2::date, $3::date, interval '1 day') d
			 LEFT JOIN LATERAL (
			   SELECT status, site_name FROM pump_day_status
			   WHERE pump_id = $1 AND day <= d::date ORDER BY day DESC LIMIT 1
			 ) st ON true`,
			[pumpId, from, to]
		),
		query<{
			on_day: string;
			at: Date;
			session_type: 'morning' | 'evening';
			counted_for: string;
			status: string;
			pairing_status: string;
			error_reason: string | null;
			test_mode: boolean | null;
		}>(
			`SELECT ${istDay('submitted_at')} AS on_day, submitted_at AS at, session_type,
			        session_date::text AS counted_for, status, pairing_status, error_reason, test_mode
			 FROM attendance_sessions
			 WHERE pump_id = $1 AND ${inRange('submitted_at')}`,
			[pumpId, from, to]
		),
		// A start that stopped waiting for its end (End session, the pairing window, an admin).
		query<{
			on_day: string;
			at: Date;
			counted_for: string;
			closed_by: 'pump' | 'timeout' | 'admin';
		}>(
			`SELECT ${istDay('closed_at')} AS on_day, closed_at AS at, session_date::text AS counted_for,
			        closed_by
			 FROM attendance_sessions
			 WHERE pump_id = $1 AND session_type = 'morning' AND pairing_status = 'expired'
			   AND closed_by IN ('pump', 'timeout', 'admin') AND ${inRange('closed_at')}`,
			[pumpId, from, to]
		),
		// Refused photos are never saved as a session; the submit endpoint logs them with the reason.
		query<{ on_day: string; at: Date; message: string; reason: string | null }>(
			`SELECT ${istDay('logged_at')} AS on_day, logged_at AS at, message,
			        details->>'reason' AS reason
			 FROM system_logs
			 WHERE pump_id = $1::text AND message = ANY($4::text[]) AND ${inRange('logged_at')}`,
			[pumpId, from, to, REFUSAL_MESSAGES]
		)
	]);

	const byDay = new Map<string, DiaryEvent[]>(daysBetween(from, to).map((d) => [d, []]));
	const add = (day: string, event: DiaryEvent) => byDay.get(day)?.push(event);
	const iso = (at: Date | string) => new Date(at).toISOString();
	for (const p of photos) {
		add(p.on_day, {
			kind: 'photo',
			at: iso(p.at),
			shift: p.session_type,
			countedFor: p.counted_for,
			status: p.status,
			pairing: p.pairing_status,
			error: p.error_reason,
			testMode: Boolean(p.test_mode)
		});
	}
	for (const c of closed) {
		add(c.on_day, { kind: 'closed', at: iso(c.at), countedFor: c.counted_for, by: c.closed_by });
	}
	for (const r of refused) {
		add(r.on_day, {
			kind: 'refused',
			at: iso(r.at),
			reason:
				r.message === 'attendance submission failed'
					? 'Could not be saved (server error)'
					: (r.reason ?? 'Refused')
		});
	}
	const statusOf = new Map(statuses.map((s) => [s.day, s]));
	// Newest day first, each day's events in the order they happened.
	return [...byDay.entries()].reverse().map(([day, events]) => ({
		day,
		status: statusOf.get(day)?.status ?? 'inactive',
		siteName: statusOf.get(day)?.site_name ?? null,
		events: events.sort((a, b) => a.at.localeCompare(b.at))
	}));
}
