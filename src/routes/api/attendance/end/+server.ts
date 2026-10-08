import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pool } from '$lib/server/db';
import { logger } from '$lib/server/log';
import { getAttendanceSettings } from '$lib/server/settings';
import { ShiftError, pumpEndShift } from '$lib/server/shiftSessions';

// Pump "End session": closes the open shift without an end photo, so the next photo starts a
// new shift instead of becoming this one's end. Workers keep "start only" for this shift.
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user || locals.user.role !== 'pump') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}
	const pumpId = locals.user.id;
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		// Same lock as submit, so an end photo and End session cannot race.
		await client.query(
			`SELECT pg_advisory_xact_lock(hashtext('attendance-submit'), hashtext($1))`,
			[pumpId]
		);
		const settings = await getAttendanceSettings(client);
		const sessionId = await pumpEndShift(client, pumpId, settings.evening_min_gap_minutes);
		await client.query('COMMIT');
		logger.info({ pumpId, sessionId }, 'shift ended by pump without end photo');
		return json({ ok: true, session_id: sessionId });
	} catch (endError) {
		await client.query('ROLLBACK').catch(() => {});
		if (endError instanceof ShiftError) {
			return json({ error: endError.message }, { status: 409 });
		}
		logger.error({ pumpId, error: String(endError) }, 'end session failed');
		return json({ error: 'Could not end the session. Try again.' }, { status: 500 });
	} finally {
		client.release();
	}
};
