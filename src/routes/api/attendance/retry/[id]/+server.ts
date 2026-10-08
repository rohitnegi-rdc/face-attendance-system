import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pool } from '$lib/server/db';
import { logger } from '$lib/server/log';
import { countFraudEvidence, deleteSession, removePhotoFiles } from '$lib/server/sessionCleanup';

// The pump may only redo a photo it has not signed off yet (failed, or still in its own review).
// Completed sessions and anything carrying fraud evidence can only be removed by an admin
// (/admin/pumps/[id]), which is audited; otherwise a pump caught by the cross-pump check could
// erase the flag by retrying.
const PUMP_RETRYABLE_STATUSES = ['failed', 'review'];

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user || locals.user.role !== 'pump') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const sessionResult = await client.query(
			`SELECT id, pump_id, session_type, status, paired_session_id
			 FROM attendance_sessions
			 WHERE id = $1
			 FOR UPDATE`,
			[params.id]
		);
		const session = sessionResult.rows[0];
		if (!session) throw error(404, 'session not found');
		if (session.pump_id !== locals.user.id) {
			await client.query('ROLLBACK');
			return json({ error: 'Forbidden' }, { status: 403 });
		}
		if (!PUMP_RETRYABLE_STATUSES.includes(session.status)) {
			await client.query('ROLLBACK');
			return json(
				{
					error:
						'This attendance is already recorded. Ask your administrator if it needs to be redone.'
				},
				{ status: 409 }
			);
		}
		if (session.session_type === 'morning' && session.paired_session_id) {
			await client.query('ROLLBACK');
			return json(
				{ error: 'Retry the paired evening attendance before retrying this morning attendance' },
				{ status: 409 }
			);
		}
		if ((await countFraudEvidence(client, session.id)) > 0) {
			await client.query('ROLLBACK');
			logger.warn(
				{ pumpId: locals.user.id, sessionId: session.id },
				'attendance retry refused: session has fraud evidence'
			);
			return json(
				{
					error: 'This photo matched a worker at another pump. Only an administrator can redo it.'
				},
				{ status: 409 }
			);
		}

		const cleanup = await deleteSession(client, session.id, { cascadePairedEvening: false });
		await client.query('COMMIT');

		await removePhotoFiles(cleanup.photoPaths);
		logger.info(
			{ pumpId: locals.user.id, sessionId: session.id, peopleRemoved: cleanup.personIds.length },
			'attendance session cleared for retry'
		);
		return json({ ok: true });
	} catch (err: any) {
		await client.query('ROLLBACK').catch(() => {});
		if (err?.status) throw err;
		logger.error(
			{ pumpId: locals.user?.id, sessionId: params.id, error: String(err?.message || err) },
			'attendance retry cleanup failed'
		);
		return json({ error: 'Could not prepare retry' }, { status: 500 });
	} finally {
		client.release();
	}
};
