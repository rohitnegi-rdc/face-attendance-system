import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pool } from '$lib/server/db';
import { logger } from '$lib/server/log';

type RollupColumn = 'days_present' | 'days_morning_only' | 'days_evening_only';

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user || locals.user.role !== 'pump') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const { rows } = await client.query(
			`SELECT id, pump_id, session_date, session_type, status
			 FROM attendance_sessions
			 WHERE id = $1
			 FOR UPDATE`,
			[params.id]
		);
		const session = rows[0];
		if (!session) throw error(404, 'session not found');
		if (session.pump_id !== locals.user.id) {
			await client.query('ROLLBACK');
			return json({ error: 'Forbidden' }, { status: 403 });
		}
		if (session.status !== 'review') {
			await client.query('ROLLBACK');
			return json({ error: 'This attendance is not awaiting review' }, { status: 409 });
		}

		await client.query(`UPDATE attendance_sessions SET status = 'completed' WHERE id = $1`, [session.id]);
		await client.query(
			`UPDATE persons
			 SET status = 'active', last_seen_at = now()
			 WHERE status = 'pending_review'
			   AND id IN (SELECT person_id FROM person_face_vectors WHERE session_id = $1)`,
			[session.id]
		);

		if (session.session_type === 'evening') {
			const { rows: finalized } = await client.query(
				`INSERT INTO attendance_rollup_finalizations (pump_id, session_date, session_id)
				 VALUES ($1, $2, $3)
				 ON CONFLICT (pump_id, session_date) DO NOTHING
				 RETURNING session_id`,
				[session.pump_id, session.session_date, session.id]
			);
			if (finalized.length) {
				const { rows: attendance } = await client.query<{
					person_id: string;
					morning_matched: boolean;
					evening_matched: boolean;
				}>(
					`SELECT person_id, morning_matched, evening_matched
					 FROM daily_person_attendance
					 WHERE pump_id = $1 AND session_date = $2`,
					[session.pump_id, session.session_date]
				);
				const year = new Date(session.session_date).getFullYear();
				for (const row of attendance) {
					const column: RollupColumn = row.morning_matched && row.evening_matched
						? 'days_present'
						: row.morning_matched
							? 'days_morning_only'
							: 'days_evening_only';
					await client.query(
						`INSERT INTO person_attendance_yearly (person_id, year, ${column})
						 VALUES ($1, $2, 1)
						 ON CONFLICT (person_id, year)
						 DO UPDATE SET ${column} = person_attendance_yearly.${column} + 1, last_updated = now()`,
						[row.person_id, year]
					);
				}
			}
		}

		await client.query('COMMIT');
		logger.info(
			{ pumpId: locals.user.id, sessionId: session.id, sessionType: session.session_type },
			'attendance review approved'
		);
		return json({ ok: true, status: 'completed' });
	} catch (err: any) {
		await client.query('ROLLBACK').catch(() => {});
		if (err?.status) throw err;
		logger.error(
			{ pumpId: locals.user?.id, sessionId: params.id, error: String(err?.message || err) },
			'attendance review approval failed'
		);
		return json({ error: 'Could not complete attendance review' }, { status: 500 });
	} finally {
		client.release();
	}
};
