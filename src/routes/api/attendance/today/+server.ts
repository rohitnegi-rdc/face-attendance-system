import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pool, queryOne } from '$lib/server/db';
import { todayIST } from '$lib/server/time';
import { getAttendanceSettings } from '$lib/server/settings';
import { expireStaleStarts } from '$lib/server/shiftSessions';

// Pump screen state. API state names keep the database words (morning = shift start,
// evening = shift end) so older clients keep working:
//   morning - no open shift: the next photo starts one
//   evening - a shift is open: the next photo ends it once next_allowed_at has passed, and
//             can_end_session offers closing it without a photo from the same moment
//   locked  - today's shift is already recorded; shift_outcome says whether it has an end
//             photo ('full') or was closed without one ('start_only', with closed_by)
//   review  - a submitted photo is waiting for the operator's review
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user || locals.user.role !== 'pump') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}
	const pumpId = locals.user.id;
	const today = todayIST();
	const settings = await getAttendanceSettings();
	const pairingWindowHours = settings.evening_pairing_window_hours;

	await expireStaleStarts(pool, pumpId, pairingWindowHours);

	const context = await queryOne<any>(
		`SELECT pu.pump_code, pl.name AS plant_name, a.name AS area_name
		 FROM pumps pu
		 JOIN plants pl ON pl.id = pu.plant_id
		 JOIN areas a ON a.id = pl.area_id
		 WHERE pu.id = $1`,
		[pumpId]
	);
	const openMorning = await queryOne<any>(
		`SELECT id, submitted_at, session_date::text AS session_date,
		        submitted_at + ($2 || ' minutes')::interval AS next_allowed_at,
		        submitted_at + ($3 || ' hours')::interval AS pairing_expires_at
		 FROM attendance_sessions
		 WHERE pump_id = $1 AND session_type = 'morning' AND status = 'completed' AND pairing_status = 'open'
		 ORDER BY submitted_at DESC LIMIT 1`,
		[pumpId, settings.evening_min_gap_minutes, pairingWindowHours]
	);
	const shiftToday = await queryOne<any>(
		`SELECT id, pairing_status, closed_by FROM attendance_sessions
		 WHERE pump_id = $1 AND session_date = $2 AND session_type = 'morning'
		   AND pairing_status <> 'open'`,
		[pumpId, today]
	);
	const reviewSession = await queryOne<any>(
		`SELECT id, session_type, status
		 FROM attendance_sessions
		 WHERE pump_id = $1 AND status = 'review'
		 ORDER BY submitted_at DESC LIMIT 1`,
		[pumpId]
	);

	const latestSession = await queryOne<any>(
		`SELECT id, session_type, status, submitted_at, processed_at
		 FROM attendance_sessions
		 WHERE pump_id = $1
		 ORDER BY submitted_at DESC LIMIT 1`,
		[pumpId]
	);

	let state: 'morning' | 'evening' | 'locked' | 'review';
	if (reviewSession) state = 'review';
	else if (openMorning) state = 'evening';
	else state = shiftToday ? 'locked' : 'morning';

	const endOpen =
		state === 'evening' && new Date(openMorning.next_allowed_at).getTime() <= Date.now();
	const canSubmit = state === 'morning' || endOpen;

	return json({
		state,
		can_submit: canSubmit,
		can_end_session: endOpen,
		open_morning_session_id: openMorning?.id ?? null,
		shift_started_at: openMorning?.submitted_at ?? null,
		shift_date: openMorning?.session_date ?? null,
		next_allowed_at: openMorning?.next_allowed_at ?? null,
		pairing_expires_at: openMorning?.pairing_expires_at ?? null,
		latest_session: latestSession,
		review_session_id: reviewSession?.id ?? null,
		shift_outcome:
			state === 'locked' ? (shiftToday.pairing_status === 'paired' ? 'full' : 'start_only') : null,
		shift_closed_by: state === 'locked' ? (shiftToday.closed_by ?? null) : null,
		today,
		...context
	});
};
