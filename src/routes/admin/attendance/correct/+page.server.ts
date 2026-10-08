import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { resolve } from '$app/paths';
import { pool, query, queryOne } from '$lib/server/db';
import { isDateKey } from '$lib/date';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const load: PageServerLoad = async ({ url }) => {
	const pumpId = url.searchParams.get('pump') || '';
	const day = url.searchParams.get('day') || '';
	if (!UUID_PATTERN.test(pumpId) || !isDateKey(day)) redirect(303, resolve('/admin/attendance'));

	const pump = await queryOne<any>(
		`SELECT pu.id, pu.pump_code, v.name AS vendor_name, pl.name AS plant_name, a.name AS area_name
		 FROM pumps pu JOIN vendors v ON v.id = pu.vendor_id JOIN plants pl ON pl.id = pu.plant_id
		 JOIN areas a ON a.id = pl.area_id WHERE pu.id = $1`,
		[pumpId]
	);
	if (!pump) error(404, 'Pump not found');

	const [sessions, people, corrections, duplicateResolutions] = await Promise.all([
		query<any>(
			`SELECT id, session_type, status, submitted_at, photo_url IS NOT NULL AS has_photo
			 FROM attendance_sessions WHERE pump_id = $1 AND session_date = $2 ORDER BY session_type DESC`,
			[pumpId, day]
		),
		query<any>(
			`SELECT p.id, p.display_seq, COALESCE(dpa.morning_matched, false) AS morning_matched,
			        COALESCE(dpa.evening_matched, false) AS evening_matched,
			        (SELECT source_photo_crop_url FROM person_face_vectors
			         WHERE person_id = p.id AND source_photo_crop_url IS NOT NULL
			         ORDER BY created_at DESC LIMIT 1) AS preview_url
			 FROM persons p LEFT JOIN daily_person_attendance dpa ON dpa.person_id = p.id AND dpa.session_date = $2
			 WHERE p.pump_id = $1 AND p.status = 'active' ORDER BY p.display_seq`,
			[pumpId, day]
		),
		query<any>(
			`SELECT ac.id, p.display_seq, ac.reason, ac.corrected_at,
			        ac.corrected_morning_matched, ac.corrected_evening_matched, adm.email AS corrected_by
			 FROM attendance_corrections ac JOIN persons p ON p.id = ac.person_id
			 JOIN admins adm ON adm.id = ac.corrected_by_admin_id
			 WHERE ac.pump_id = $1 AND ac.session_date = $2 ORDER BY ac.corrected_at DESC LIMIT 20`,
			[pumpId, day]
		),
		query<any>(
			`SELECT adr.id, adr.kept_person_id, adr.duplicate_person_id, adr.session_type,
			        adr.reason, adr.resolved_at, adr.reversed_at, kept.display_seq AS kept_display_seq,
			        duplicate.display_seq AS duplicate_display_seq, adm.email AS resolved_by
			 FROM attendance_duplicate_resolutions adr
			 JOIN persons kept ON kept.id = adr.kept_person_id
			 JOIN persons duplicate ON duplicate.id = adr.duplicate_person_id
			 JOIN admins adm ON adm.id = adr.resolved_by_admin_id
			 WHERE adr.pump_id = $1 AND adr.session_date = $2
			 ORDER BY adr.resolved_at DESC LIMIT 20`,
			[pumpId, day]
		)
	]);
	return { pump, day, sessions, people, corrections, duplicateResolutions };
};

export const actions: Actions = {
	correct: async ({ request, locals }) => {
		if (!locals.user || locals.user.role !== 'admin') return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const personId = String(form.get('person_id') || '');
		const pumpId = String(form.get('pump_id') || '');
		const day = String(form.get('day') || '');
		const reason = String(form.get('reason') || '').trim();
		const morningMatched = form.get('morning_present') === 'on';
		const eveningMatched = form.get('evening_present') === 'on';
		if (!UUID_PATTERN.test(personId) || !UUID_PATTERN.test(pumpId) || !isDateKey(day)) {
			return fail(400, { error: 'Invalid attendance correction request' });
		}
		if (reason.length < 5 || reason.length > 500) {
			return fail(400, { error: 'Enter a correction reason between 5 and 500 characters', personId });
		}

		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const person = await client.query(
				`SELECT id FROM persons WHERE id = $1 AND pump_id = $2 AND status = 'active' FOR UPDATE`,
				[personId, pumpId]
			);
			if (!person.rowCount) {
				await client.query('ROLLBACK');
				return fail(404, { error: 'Worker not found for this pump', personId });
			}
			const sessions = await client.query(
				`SELECT session_type FROM attendance_sessions
				 WHERE pump_id = $1 AND session_date = $2 AND status IN ('review', 'completed')`,
				[pumpId, day]
			);
			if (!sessions.rowCount) {
				await client.query('ROLLBACK');
				return fail(409, { error: 'No completed attendance session exists for this date', personId });
			}
			const available = new Set(sessions.rows.map((row) => row.session_type));
			if ((morningMatched && !available.has('morning')) || (eveningMatched && !available.has('evening'))) {
				await client.query('ROLLBACK');
				return fail(409, { error: 'Attendance cannot be added without its source session', personId });
			}
			const existing = await client.query(
				`SELECT morning_matched, evening_matched FROM daily_person_attendance
				 WHERE person_id = $1 AND session_date = $2 FOR UPDATE`,
				[personId, day]
			);
			const previousMorning = existing.rows[0]?.morning_matched ?? false;
			const previousEvening = existing.rows[0]?.evening_matched ?? false;

			await client.query(
				`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched, evening_matched, updated_at)
				 VALUES ($1, $2, $3, $4, $5, now())
				 ON CONFLICT (person_id, session_date) DO UPDATE SET morning_matched = EXCLUDED.morning_matched,
				 evening_matched = EXCLUDED.evening_matched, updated_at = now()`,
				[personId, pumpId, day, morningMatched, eveningMatched]
			);
			await client.query(
				`INSERT INTO attendance_corrections
				 (person_id, pump_id, session_date, previous_morning_matched, previous_evening_matched,
				  corrected_morning_matched, corrected_evening_matched, reason, corrected_by_admin_id)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				[personId, pumpId, day, previousMorning, previousEvening, morningMatched, eveningMatched, reason, locals.user.id]
			);
			await client.query(
				`INSERT INTO person_attendance_yearly
				 (person_id, year, days_present, days_morning_only, days_evening_only, last_updated)
				 SELECT $1, EXTRACT(YEAR FROM $2::date)::int,
				 COUNT(*) FILTER (WHERE morning_matched AND evening_matched),
				 COUNT(*) FILTER (WHERE morning_matched AND NOT evening_matched),
				 COUNT(*) FILTER (WHERE NOT morning_matched AND evening_matched), now()
				 FROM daily_person_attendance WHERE person_id = $1
				 AND EXTRACT(YEAR FROM session_date) = EXTRACT(YEAR FROM $2::date)
				 ON CONFLICT (person_id, year) DO UPDATE SET days_present = EXCLUDED.days_present,
				 days_morning_only = EXCLUDED.days_morning_only, days_evening_only = EXCLUDED.days_evening_only,
				 last_updated = now()`,
				[personId, day]
			);
			await client.query('COMMIT');
			return { success: true, personId, message: 'Attendance correction saved' };
		} catch (err) {
			await client.query('ROLLBACK');
			console.error('attendance correction failed', err);
			return fail(500, { error: 'Could not save the attendance correction', personId });
		} finally {
			client.release();
		}
	},
	markDuplicate: async ({ request, locals }) => {
		if (!locals.user || locals.user.role !== 'admin') return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const keptId = String(form.get('kept_person_id') || '');
		const duplicateId = String(form.get('duplicate_person_id') || '');
		const pumpId = String(form.get('pump_id') || '');
		const day = String(form.get('day') || '');
		const sessionType = String(form.get('session_type') || '');
		const reason = String(form.get('duplicate_reason') || '').trim();
		if (![keptId, duplicateId, pumpId].every((value) => UUID_PATTERN.test(value)) || keptId === duplicateId || !isDateKey(day)) {
			return fail(400, { error: 'Choose a valid duplicate worker' });
		}
		if (!['morning', 'evening'].includes(sessionType)) return fail(400, { error: 'Choose morning or evening' });
		if (reason.length < 5 || reason.length > 500) return fail(400, { error: 'Enter a reason between 5 and 500 characters' });

		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const pair = await client.query(
				`SELECT a.id FROM persons a JOIN persons b ON b.id = $2
				 WHERE a.id = $1 AND a.pump_id = $3 AND b.pump_id = $3
				 AND a.status = 'active' AND b.status = 'active' FOR UPDATE OF a, b`,
				[keptId, duplicateId, pumpId]
			);
			if (!pair.rowCount) throw new Error('Both workers must be active at the same pump.');
			const session = await client.query(
				`SELECT id FROM attendance_sessions WHERE pump_id = $1 AND session_date = $2
				 AND session_type = $3 AND status IN ('review', 'completed')`,
				[pumpId, day, sessionType]
			);
			if (!session.rowCount) throw new Error('No completed source session exists for this selection.');
			const existingResolution = await client.query(
				`SELECT id FROM attendance_duplicate_resolutions WHERE pump_id = $1 AND session_date = $2
				 AND session_type = $3 AND duplicate_person_id = $4 AND reversed_at IS NULL FOR UPDATE`,
				[pumpId, day, sessionType, duplicateId]
			);
			if (existingResolution.rowCount) throw new Error('This worker is already marked duplicate for that session.');
			const previous = await client.query(
				`SELECT person_id, morning_matched, evening_matched FROM daily_person_attendance
				 WHERE session_date = $1 AND person_id IN ($2, $3) FOR UPDATE`,
				[day, keptId, duplicateId]
			);
			const previousFor = (personId: string) => {
				const row = previous.rows.find((item) => item.person_id === personId);
				return sessionType === 'morning' ? (row?.morning_matched ?? false) : (row?.evening_matched ?? false);
			};

			await client.query(
				`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched, evening_matched, updated_at)
				 VALUES ($1, $2, $3, $4, $5, now())
				 ON CONFLICT (person_id, session_date) DO UPDATE SET
				 morning_matched = CASE WHEN $6 = 'morning' THEN $4 ELSE daily_person_attendance.morning_matched END,
				 evening_matched = CASE WHEN $6 = 'evening' THEN $5 ELSE daily_person_attendance.evening_matched END,
				 updated_at = now()`,
				[keptId, pumpId, day, sessionType === 'morning', sessionType === 'evening', sessionType]
			);
			await client.query(
				`UPDATE daily_person_attendance SET
				 morning_matched = CASE WHEN $3 = 'morning' THEN false ELSE morning_matched END,
				 evening_matched = CASE WHEN $3 = 'evening' THEN false ELSE evening_matched END,
				 updated_at = now() WHERE person_id = $1 AND session_date = $2`,
				[duplicateId, day, sessionType]
			);
			await client.query(
				`INSERT INTO attendance_duplicate_resolutions
				 (kept_person_id, duplicate_person_id, pump_id, session_date, session_type,
				  previous_kept_present, previous_duplicate_present, reason, resolved_by_admin_id)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				[keptId, duplicateId, pumpId, day, sessionType, previousFor(keptId), previousFor(duplicateId), reason, locals.user.id]
			);
			await recalculateYear(client, keptId, day);
			await recalculateYear(client, duplicateId, day);
			await client.query('COMMIT');
			return { success: true, message: 'Duplicate detection removed; the selected worker remains present.' };
		} catch (err) {
			await client.query('ROLLBACK');
			console.error('attendance duplicate resolution failed', err);
			return fail(400, { error: err instanceof Error ? err.message : 'Could not resolve duplicate detection' });
		} finally {
			client.release();
		}
	},
	undoDuplicate: async ({ request, locals }) => {
		if (!locals.user || locals.user.role !== 'admin') return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const resolutionId = String(form.get('resolution_id') || '');
		if (!UUID_PATTERN.test(resolutionId)) return fail(400, { error: 'Invalid duplicate resolution' });
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const result = await client.query(
				`SELECT * FROM attendance_duplicate_resolutions WHERE id = $1 AND reversed_at IS NULL FOR UPDATE`,
				[resolutionId]
			);
			if (!result.rowCount) throw new Error('This duplicate decision has already been reversed.');
			const resolution = result.rows[0];
			for (const [personId, present] of [[resolution.kept_person_id, resolution.previous_kept_present], [resolution.duplicate_person_id, resolution.previous_duplicate_present]]) {
				await client.query(
					`UPDATE daily_person_attendance SET
					 morning_matched = CASE WHEN $3 = 'morning' THEN COALESCE($4, false) ELSE morning_matched END,
					 evening_matched = CASE WHEN $3 = 'evening' THEN COALESCE($4, false) ELSE evening_matched END,
					 updated_at = now() WHERE person_id = $1 AND session_date = $2`,
					[personId, resolution.session_date, resolution.session_type, present]
				);
				await recalculateYear(client, personId, resolution.session_date);
			}
			await client.query(
				`UPDATE attendance_duplicate_resolutions SET reversed_at = now(), reversed_by_admin_id = $2 WHERE id = $1`,
				[resolutionId, locals.user.id]
			);
			await client.query('COMMIT');
			return { success: true, message: 'Duplicate decision undone and previous attendance restored.' };
		} catch (err) {
			await client.query('ROLLBACK');
			return fail(400, { error: err instanceof Error ? err.message : 'Could not undo duplicate decision' });
		} finally {
			client.release();
		}
	}
};

async function recalculateYear(client: import('pg').PoolClient, personId: string, day: string) {
	await client.query(
		`INSERT INTO person_attendance_yearly
		 (person_id, year, days_present, days_morning_only, days_evening_only, last_updated)
		 SELECT $1, EXTRACT(YEAR FROM $2::date)::int,
		 COUNT(*) FILTER (WHERE morning_matched AND evening_matched),
		 COUNT(*) FILTER (WHERE morning_matched AND NOT evening_matched),
		 COUNT(*) FILTER (WHERE NOT morning_matched AND evening_matched), now()
		 FROM daily_person_attendance WHERE person_id = $1
		 AND EXTRACT(YEAR FROM session_date) = EXTRACT(YEAR FROM $2::date)
		 ON CONFLICT (person_id, year) DO UPDATE SET days_present = EXCLUDED.days_present,
		 days_morning_only = EXCLUDED.days_morning_only, days_evening_only = EXCLUDED.days_evening_only,
		 last_updated = now()`,
		[personId, day]
	);
}
