import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { pool } from '$lib/server/db';
import { logger } from '$lib/server/log';

type RollupColumn = 'days_present' | 'days_morning_only' | 'days_evening_only';

async function undoFinalizedRollup(client: PoolClient, pumpId: string, sessionDate: string | Date) {
	const finalization = await client.query(
		`DELETE FROM attendance_rollup_finalizations
		 WHERE pump_id = $1 AND session_date = $2
		 RETURNING session_id`,
		[pumpId, sessionDate]
	);
	if (!finalization.rowCount) return 0;

	const finalizedPeople = await client.query<{
		person_id: string;
		year: number;
		rollup_column: RollupColumn | null;
	}>(
		`SELECT person_id,
		        EXTRACT(YEAR FROM session_date)::int AS year,
		        CASE
		          WHEN morning_matched AND evening_matched THEN 'days_present'
		          WHEN morning_matched THEN 'days_morning_only'
		          WHEN evening_matched THEN 'days_evening_only'
		          ELSE NULL
		        END AS rollup_column
		 FROM daily_person_attendance
		 WHERE pump_id = $1 AND session_date = $2`,
		[pumpId, sessionDate]
	);

	for (const row of finalizedPeople.rows) {
		if (!row.rollup_column) continue;
		await client.query(
			`UPDATE person_attendance_yearly
			 SET ${row.rollup_column} = GREATEST(${row.rollup_column} - 1, 0),
			     last_updated = now()
			 WHERE person_id = $1 AND year = $2`,
			[row.person_id, row.year]
		);
	}

	return finalization.rowCount;
}

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user || locals.user.role !== 'pump') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const client = await pool.connect();
	let photoPath: string | null = null;

	try {
		await client.query('BEGIN');
		const sessionResult = await client.query(
			`SELECT id, pump_id, session_date, session_type, status, photo_url, paired_session_id
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
		if (!['review', 'completed', 'failed'].includes(session.status)) {
			await client.query('ROLLBACK');
			return json({ error: 'Only reviewed, completed, or failed sessions can be retried' }, { status: 409 });
		}
		if (session.session_type === 'morning' && session.paired_session_id) {
			await client.query('ROLLBACK');
			return json(
				{ error: 'Retry the paired evening attendance before retrying this morning attendance' },
				{ status: 409 }
			);
		}

		photoPath = session.photo_url;
		const matchedCol = session.session_type === 'morning' ? 'morning_matched' : 'evening_matched';
		const confidenceCol =
			session.session_type === 'morning' ? 'morning_confidence' : 'evening_confidence';
		const unfinalizedRollups = await undoFinalizedRollup(
			client,
			session.pump_id,
			session.session_date
		);

		const affectedPersons = await client.query(
			`SELECT person_id FROM person_face_vectors WHERE session_id = $1
			 UNION
			 SELECT person_id FROM attendance_face_evidence WHERE session_id = $1`,
			[session.id]
		);
		const personIds = affectedPersons.rows.map((row) => row.person_id);

		await client.query(`DELETE FROM fraud_flags WHERE session_id = $1 OR matched_session_id = $1`, [
			session.id
		]);
		await client.query(`DELETE FROM attendance_review_flags WHERE session_id = $1`, [session.id]);
		await client.query(`DELETE FROM flagged_guests WHERE session_id = $1`, [session.id]);
		await client.query(`DELETE FROM attendance_face_evidence WHERE session_id = $1`, [session.id]);
		await client.query(`DELETE FROM person_face_vectors WHERE session_id = $1`, [session.id]);
		await client.query(`DELETE FROM attendance_jobs WHERE session_id = $1`, [session.id]);

		if (personIds.length) {
			await client.query(
				`UPDATE daily_person_attendance
				 SET ${matchedCol} = false, ${confidenceCol} = NULL, updated_at = now()
				 WHERE session_date = $1 AND person_id = ANY($2::uuid[])`,
				[session.session_date, personIds]
			);
			await client.query(
				`DELETE FROM daily_person_attendance
				 WHERE session_date = $1
				   AND person_id = ANY($2::uuid[])
				   AND morning_matched = false
				   AND evening_matched = false`,
				[session.session_date, personIds]
			);
			await client.query(
				`DELETE FROM persons WHERE id = ANY($1::uuid[]) AND status = 'pending_review'`,
				[personIds]
			);
		}

		if (session.session_type === 'evening' && session.paired_session_id) {
			await client.query(
				`UPDATE attendance_sessions
				 SET paired_session_id = NULL, pairing_status = 'open'
				 WHERE id = $1`,
				[session.paired_session_id]
			);
		}

		await client.query(`DELETE FROM attendance_sessions WHERE id = $1`, [session.id]);
		await client.query('COMMIT');

		if (photoPath) await fs.unlink(photoPath).catch(() => {});
		logger.info(
			{ pumpId: locals.user.id, sessionId: session.id, unfinalizedRollups },
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
