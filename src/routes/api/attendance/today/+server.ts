import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { queryOne } from '$lib/server/db';
import { todayIST } from '$lib/server/time';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user || locals.user.role !== 'pump') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}
	const pumpId = locals.user.id;
	const today = todayIST();
	const pairingWindowHours = Number(process.env.EVENING_PAIRING_WINDOW_HOURS ?? 24);

	await queryOne(
		`UPDATE attendance_sessions
		 SET pairing_status = 'expired'
		 WHERE pump_id = $1 AND session_type = 'morning' AND pairing_status = 'open'
		   AND now() - submitted_at > ($2 || ' hours')::interval
		 RETURNING id`,
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
