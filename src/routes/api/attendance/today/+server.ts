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

	const openMorning = await queryOne<any>(
		`SELECT id, submitted_at FROM attendance_sessions
		 WHERE pump_id = $1 AND session_type = 'morning' AND pairing_status = 'open'
		 ORDER BY submitted_at DESC LIMIT 1`,
		[pumpId]
	);
	const eveningToday = await queryOne<any>(
		`SELECT id FROM attendance_sessions
		 WHERE pump_id = $1 AND session_date = $2 AND session_type = 'evening'`,
		[pumpId, today]
	);

	let state: 'morning' | 'evening' | 'locked';
	if (!openMorning) state = eveningToday ? 'locked' : 'morning';
	else state = 'evening';

	return json({ state, open_morning_session_id: openMorning?.id ?? null, today });
};
