import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pool } from '$lib/server/db';
import { logger } from '$lib/server/log';
import { cleanPersonName } from '$lib/personLabel';

type RollupColumn = 'days_present' | 'days_morning_only' | 'days_evening_only';

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user || locals.user.role !== 'pump') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const { rows } = await client.query(
			`SELECT id, pump_id, session_date, session_type, status,
			        EXTRACT(YEAR FROM session_date)::int AS session_year
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

		// Every worker in this photo must have a name before the operator can complete it. Names
		// come as { names: { [person_id]: "Name" } }; workers named earlier keep their name.
		const body = await request.json().catch(() => ({}));
		const given: Record<string, unknown> =
			body && typeof body.names === 'object' && body.names ? body.names : {};
		const { rows: unnamed } = await client.query<{ id: string; display_seq: number }>(
			`SELECT DISTINCT p.id, p.display_seq FROM persons p
			 JOIN person_face_vectors v ON v.person_id = p.id
			 WHERE v.session_id = $1 AND p.name IS NULL AND p.status IN ('active', 'pending_review')
			 ORDER BY p.display_seq`,
			[session.id]
		);
		const names = unnamed.map((person) => ({ ...person, name: cleanPersonName(given[person.id]) }));
		const missing = names.filter((person) => !person.name);
		if (missing.length) {
			await client.query('ROLLBACK');
			return json(
				{
					error: 'Write a name for every worker before completing.',
					unnamed: missing.map((person) => person.id)
				},
				{ status: 422 }
			);
		}
		const lower = names.map((person) => person.name!.toLowerCase());
		const taken = await client.query<{ name: string }>(
			`SELECT name FROM persons
			 WHERE pump_id = $1 AND lower(name) = ANY($2::text[]) AND status IN ('active', 'pending_review')`,
			[session.pump_id, lower]
		);
		const repeated = lower.find((name, i) => lower.indexOf(name) !== i);
		if (taken.rowCount || repeated) {
			await client.query('ROLLBACK');
			const name = taken.rows[0]?.name ?? names[lower.indexOf(repeated!)].name;
			return json(
				{
					error: `"${name}" is already the name of another worker at this pump. Add something to tell them apart, for example the father's name or village.`,
					duplicate: name
				},
				{ status: 409 }
			);
		}
		for (const person of names) {
			await client.query(
				`UPDATE persons SET name = $2, named_by = 'pump', named_at = now() WHERE id = $1`,
				[person.id, person.name]
			);
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
				// From SQL: a JS Date of a DATE column depends on the process time zone, which can
				// shift a 1 January shift into the previous year.
				const year: number = session.session_year;
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
		// The same name saved by a parallel request between the check and the update.
		if (err?.code === '23505') {
			return json(
				{ error: 'That name is already the name of another worker at this pump.' },
				{ status: 409 }
			);
		}
		logger.error(
			{ pumpId: locals.user?.id, sessionId: params.id, error: String(err?.message || err) },
			'attendance review approval failed'
		);
		return json({ error: 'Could not complete attendance review' }, { status: 500 });
	} finally {
		client.release();
	}
};
