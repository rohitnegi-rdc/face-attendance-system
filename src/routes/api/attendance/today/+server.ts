import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query, queryOne } from '$lib/server/db';
import { todayIST } from '$lib/server/time';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user || locals.user.role !== 'pump') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}
	const pumpId = locals.user.id;
	const today = todayIST();
	const pairingWindowHours = Number(process.env.EVENING_PAIRING_WINDOW_HOURS ?? 24);

	await query(
		`WITH expired AS (
		   UPDATE attendance_sessions
		   SET pairing_status = 'expired'
		   WHERE pump_id = $1
		     AND session_type = 'morning'
		     AND pairing_status = 'open'
		     AND now() - submitted_at > ($2 || ' hours')::interval
		   RETURNING id, pump_id, session_date
		 ),
		 finalized AS (
		   INSERT INTO attendance_rollup_finalizations (pump_id, session_date, session_id)
		   SELECT pump_id, session_date, id FROM expired
		   ON CONFLICT (pump_id, session_date) DO NOTHING
		   RETURNING pump_id, session_date
		 )
		 INSERT INTO person_attendance_yearly (person_id, year, days_morning_only)
		 SELECT dpa.person_id, EXTRACT(YEAR FROM dpa.session_date)::int, 1
		 FROM daily_person_attendance dpa
		 JOIN finalized f
		   ON f.pump_id = dpa.pump_id AND f.session_date = dpa.session_date
		 WHERE dpa.morning_matched AND NOT dpa.evening_matched
		 ON CONFLICT (person_id, year)
		 DO UPDATE SET
		   days_morning_only = person_attendance_yearly.days_morning_only + 1,
		   last_updated = now()`,
		[pumpId, pairingWindowHours]
	);

	const context = await queryOne<any>(
		`SELECT pu.pump_code, pl.name AS plant_name, a.name AS area_name
		 FROM pumps pu
		 JOIN plants pl ON pl.id = pu.plant_id
		 JOIN areas a ON a.id = pl.area_id
		 WHERE pu.id = $1`,
		[pumpId]
	);
	const openMorning = await queryOne<any>(
		`SELECT id, submitted_at,
		        submitted_at + interval '9 hours' AS next_allowed_at,
		        submitted_at + ($2 || ' hours')::interval AS pairing_expires_at
		 FROM attendance_sessions
		 WHERE pump_id = $1 AND session_type = 'morning' AND pairing_status = 'open'
		 ORDER BY submitted_at DESC LIMIT 1`,
		[pumpId, pairingWindowHours]
	);
	const eveningToday = await queryOne<any>(
		`SELECT id FROM attendance_sessions
		 WHERE pump_id = $1 AND session_date = $2 AND session_type = 'evening'`,
		[pumpId, today]
	);

	const latestSession = await queryOne<any>(
		`SELECT id, session_type, status, submitted_at, processed_at
		 FROM attendance_sessions
		 WHERE pump_id = $1
		 ORDER BY submitted_at DESC LIMIT 1`,
		[pumpId]
	);

	let state: 'morning' | 'evening' | 'locked';
	if (!openMorning) state = eveningToday ? 'locked' : 'morning';
	else state = 'evening';

	const canSubmit =
		state === 'morning' ||
		(state === 'evening' &&
			openMorning &&
			new Date(openMorning.next_allowed_at).getTime() <= Date.now());

	return json({
		state,
		can_submit: canSubmit,
		open_morning_session_id: openMorning?.id ?? null,
		next_allowed_at: openMorning?.next_allowed_at ?? null,
		pairing_expires_at: openMorning?.pairing_expires_at ?? null,
		latest_session: latestSession,
		today,
		...context
	});
};
