import fs from 'node:fs/promises';
import type { PoolClient } from 'pg';

// Removing attendance sessions and people without leaving half-counted rollups or dangling rows.
// Used by the pump's own Retry (narrow, pre-checked) and by admin delete/reset (full, audited).
// Every function expects the caller to have opened a transaction on `client`.

type RollupColumn = 'days_present' | 'days_morning_only' | 'days_evening_only';

export interface CleanupResult {
	sessionIds: string[];
	personIds: string[];
	photoPaths: string[];
	fraudFlagsDeleted: number;
}

function emptyResult(): CleanupResult {
	return { sessionIds: [], personIds: [], photoPaths: [], fraudFlagsDeleted: 0 };
}

function mergeInto(target: CleanupResult, source: CleanupResult) {
	target.sessionIds.push(...source.sessionIds);
	target.personIds.push(...source.personIds);
	target.photoPaths.push(...source.photoPaths);
	target.fraudFlagsDeleted += source.fraudFlagsDeleted;
}

// Reverses the yearly rollup written when the day was finalized, so a deleted or retried
// session never leaves a counted day behind.
export async function undoFinalizedRollup(
	client: PoolClient,
	pumpId: string,
	sessionDate: string | Date
): Promise<number> {
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

	return finalization.rowCount ?? 0;
}

// Fraud evidence tied to a session: flags raised on it, flags at other pumps that point at it,
// and flags on people first seen in it. A pump must never be able to delete any of these.
export async function countFraudEvidence(client: PoolClient, sessionId: string): Promise<number> {
	const { rows } = await client.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM fraud_flags
		 WHERE session_id = $1
		    OR matched_session_id = $1
		    OR person_id IN (SELECT person_id FROM person_face_vectors WHERE session_id = $1)`,
		[sessionId]
	);
	return rows[0]?.count ?? 0;
}

// Deletes people and every row that references them. Admin-only paths, plus the pump's own
// not-yet-approved people (which carry no fraud evidence, checked by the caller).
export async function deletePersons(client: PoolClient, personIds: string[]): Promise<number> {
	if (!personIds.length) return 0;
	const ids = [personIds];
	const fraud = await client.query(
		'DELETE FROM fraud_flags WHERE person_id = ANY($1::uuid[])',
		ids
	);
	await client.query('DELETE FROM attendance_review_flags WHERE person_id = ANY($1::uuid[])', ids);
	await client.query('DELETE FROM attendance_face_evidence WHERE person_id = ANY($1::uuid[])', ids);
	await client.query('DELETE FROM person_face_vectors WHERE person_id = ANY($1::uuid[])', ids);
	await client.query('DELETE FROM daily_person_attendance WHERE person_id = ANY($1::uuid[])', ids);
	await client.query('DELETE FROM person_attendance_yearly WHERE person_id = ANY($1::uuid[])', ids);
	await client.query('DELETE FROM attendance_corrections WHERE person_id = ANY($1::uuid[])', ids);
	await client.query(
		`DELETE FROM attendance_duplicate_resolutions
		 WHERE kept_person_id = ANY($1::uuid[]) OR duplicate_person_id = ANY($1::uuid[])`,
		ids
	);
	await client.query(
		`DELETE FROM person_merge_log
		 WHERE kept_person_id = ANY($1::uuid[]) OR merged_person_id = ANY($1::uuid[])`,
		ids
	);
	await client.query(
		`DELETE FROM merge_review_decisions
		 WHERE lower_person_id = ANY($1::uuid[]) OR higher_person_id = ANY($1::uuid[])`,
		ids
	);
	await client.query(
		'UPDATE persons SET merged_into_person_id = NULL WHERE merged_into_person_id = ANY($1::uuid[])',
		ids
	);
	await client.query('DELETE FROM persons WHERE id = ANY($1::uuid[])', ids);
	return fraud.rowCount ?? 0;
}

// Deletes one session and undoes everything it contributed: attendance flags for that slot,
// rollups, review/fraud rows, people first created by it, the job and the pairing link.
// A morning with a paired evening is refused unless `cascadePairedEvening` is set, in which case
// the evening is deleted first (admin reset of a whole day).
export async function deleteSession(
	client: PoolClient,
	sessionId: string,
	options: { cascadePairedEvening: boolean }
): Promise<CleanupResult> {
	const result = emptyResult();
	const { rows } = await client.query(
		`SELECT id, pump_id, session_date, session_type, photo_url, paired_session_id
		 FROM attendance_sessions WHERE id = $1 FOR UPDATE`,
		[sessionId]
	);
	const session = rows[0];
	if (!session) return result;

	if (session.session_type === 'morning' && session.paired_session_id) {
		if (!options.cascadePairedEvening) {
			throw new Error('morning has a paired evening');
		}
		mergeInto(result, await deleteSession(client, session.paired_session_id, options));
	}

	const matchedCol = session.session_type === 'morning' ? 'morning_matched' : 'evening_matched';
	const confidenceCol =
		session.session_type === 'morning' ? 'morning_confidence' : 'evening_confidence';
	await undoFinalizedRollup(client, session.pump_id, session.session_date);

	const affected = await client.query<{ person_id: string }>(
		`SELECT person_id FROM person_face_vectors WHERE session_id = $1
		 UNION
		 SELECT person_id FROM attendance_face_evidence WHERE session_id = $1`,
		[session.id]
	);
	const personIds = affected.rows.map((row) => row.person_id);

	const fraud = await client.query(
		'DELETE FROM fraud_flags WHERE session_id = $1 OR matched_session_id = $1',
		[session.id]
	);
	result.fraudFlagsDeleted += fraud.rowCount ?? 0;
	await client.query('DELETE FROM attendance_review_flags WHERE session_id = $1', [session.id]);
	await client.query('DELETE FROM flagged_guests WHERE session_id = $1', [session.id]);
	await client.query('DELETE FROM attendance_face_evidence WHERE session_id = $1', [session.id]);
	await client.query('DELETE FROM person_face_vectors WHERE session_id = $1', [session.id]);
	await client.query('DELETE FROM attendance_jobs WHERE session_id = $1', [session.id]);

	if (personIds.length) {
		await client.query(
			`UPDATE daily_person_attendance
			 SET ${matchedCol} = false, ${confidenceCol} = NULL, updated_at = now()
			 WHERE session_date = $1 AND person_id = ANY($2::uuid[])`,
			[session.session_date, personIds]
		);
		await client.query(
			`DELETE FROM daily_person_attendance
			 WHERE session_date = $1 AND person_id = ANY($2::uuid[])
			   AND morning_matched = false AND evening_matched = false`,
			[session.session_date, personIds]
		);
		const pending = await client.query<{ id: string }>(
			`SELECT id FROM persons WHERE id = ANY($1::uuid[]) AND status = 'pending_review'`,
			[personIds]
		);
		const pendingIds = pending.rows.map((row) => row.id);
		result.fraudFlagsDeleted += await deletePersons(client, pendingIds);
		result.personIds.push(...pendingIds);
	}

	if (session.session_type === 'evening' && session.paired_session_id) {
		await client.query(
			`UPDATE attendance_sessions SET paired_session_id = NULL, pairing_status = 'open'
			 WHERE id = $1`,
			[session.paired_session_id]
		);
	}
	await client.query('UPDATE attendance_sessions SET paired_session_id = NULL WHERE id = $1', [
		session.id
	]);
	await client.query('DELETE FROM attendance_sessions WHERE id = $1', [session.id]);

	result.sessionIds.push(session.id);
	if (session.photo_url) result.photoPaths.push(session.photo_url);
	return result;
}

// Wipes every attendance record of one pump (sessions, people, rollups, flags). The pump
// account itself stays. Meant for clearing test data; callers must audit it.
export async function clearPumpAttendance(
	client: PoolClient,
	pumpId: string
): Promise<CleanupResult> {
	const result = emptyResult();
	const { rows: sessions } = await client.query<{ id: string }>(
		`SELECT id FROM attendance_sessions WHERE pump_id = $1
		 ORDER BY (session_type = 'evening') DESC, submitted_at DESC`,
		[pumpId]
	);
	for (const session of sessions) {
		mergeInto(result, await deleteSession(client, session.id, { cascadePairedEvening: true }));
	}

	const { rows: people } = await client.query<{ id: string }>(
		'SELECT id FROM persons WHERE pump_id = $1',
		[pumpId]
	);
	const personIds = people.map((row) => row.id);
	result.fraudFlagsDeleted += await deletePersons(client, personIds);
	result.personIds.push(...personIds);

	const otherPumpFlags = await client.query(
		'DELETE FROM fraud_flags WHERE matched_at_pump_id = $1',
		[pumpId]
	);
	result.fraudFlagsDeleted += otherPumpFlags.rowCount ?? 0;
	await client.query('DELETE FROM attendance_corrections WHERE pump_id = $1', [pumpId]);
	await client.query('DELETE FROM attendance_duplicate_resolutions WHERE pump_id = $1', [pumpId]);
	await client.query('DELETE FROM daily_person_attendance WHERE pump_id = $1', [pumpId]);
	await client.query('DELETE FROM attendance_rollup_finalizations WHERE pump_id = $1', [pumpId]);
	return result;
}

// Photo files are removed only after the transaction commits, so a rollback never loses them.
export async function removePhotoFiles(paths: string[]) {
	await Promise.all(paths.map((photoPath) => fs.unlink(photoPath).catch(() => {})));
}
