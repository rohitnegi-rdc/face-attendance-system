import type { PoolClient } from 'pg';
import { cleanPersonName } from '../personLabel';
import { shiftStillOpen } from './shiftSessions';
import { trimGallery } from '../../../worker/faceQueries.js';

// Admin fixes for faces the matcher got wrong. All run inside the caller's transaction and are
// audited in admin_audit_log. One rule holds throughout: one face per worker per photo.
//   moveFace          a face counted for the wrong worker goes to the right one (or a new worker)
//   markPresent       a worker the camera missed is counted for a photo (an existing or new worker)
//   undoMerge         a wrong merge is reversed: the merged worker gets back the photos they were in
//   resolveReviewFlag closes an admin's "Flag error" with one of the fixes above, or dismisses it

export class FaceFixError extends Error {}

type Session = {
	id: string;
	pump_id: string;
	session_date: string;
	session_type: 'morning' | 'evening';
};

async function lockSession(client: PoolClient, sessionId: string): Promise<Session> {
	const { rows } = await client.query<Session>(
		`SELECT id, pump_id, session_date::text AS session_date, session_type
		 FROM attendance_sessions WHERE id = $1 FOR UPDATE`,
		[sessionId]
	);
	if (!rows[0]) throw new FaceFixError('Shift photo not found.');
	return rows[0];
}

async function lockPumpWorker(client: PoolClient, personId: string, pumpId: string) {
	const { rowCount } = await client.query(
		`SELECT 1 FROM persons
		 WHERE id = $1 AND pump_id = $2 AND status IN ('active', 'pending_review') FOR UPDATE`,
		[personId, pumpId]
	);
	if (!rowCount) throw new FaceFixError('Choose a worker of this pump.');
}

async function inPhoto(client: PoolClient, sessionId: string, personId: string) {
	const { rowCount } = await client.query(
		'SELECT 1 FROM attendance_face_evidence WHERE session_id = $1 AND person_id = $2',
		[sessionId, personId]
	);
	return rowCount === 1;
}

// A worker the admin or plant manager creates is active at once: they have looked at the face or
// the photo.
async function createWorker(
	client: PoolClient,
	pumpId: string,
	rawName: unknown,
	namedBy: FixActor['role'] = 'admin'
) {
	const name = rawName == null || rawName === '' ? null : cleanPersonName(rawName);
	if (rawName && !name) throw new FaceFixError('Enter a name of 2 to 60 letters.');
	const { rows } = await client.query<{ id: string }>(
		`INSERT INTO persons (pump_id, status, display_seq, name, named_by, named_at)
		 VALUES ($1, 'active', (SELECT COALESCE(MAX(display_seq), 0) + 1 FROM persons WHERE pump_id = $1),
		         $2::text, CASE WHEN $2::text IS NULL THEN NULL ELSE $3 END,
		         CASE WHEN $2::text IS NULL THEN NULL ELSE now() END)
		 RETURNING id`,
		[pumpId, name, namedBy]
	);
	return rows[0].id;
}

// The yearly totals from the day rows, the same count as Attendance > Correct.
export async function recalculateYear(client: PoolClient, personId: string, day: string) {
	await client.query(
		`INSERT INTO person_attendance_yearly
		 (person_id, year, days_present, days_morning_only, days_evening_only, last_updated)
		 SELECT $1, EXTRACT(YEAR FROM $2::date)::int,
		 COUNT(*) FILTER (WHERE morning_matched AND evening_matched),
		 COUNT(*) FILTER (WHERE morning_matched AND NOT evening_matched
		   AND NOT ${shiftStillOpen('daily_person_attendance')}),
		 COUNT(*) FILTER (WHERE NOT morning_matched AND evening_matched), now()
		 FROM daily_person_attendance WHERE person_id = $1
		 AND EXTRACT(YEAR FROM session_date) = EXTRACT(YEAR FROM $2::date)
		 ON CONFLICT (person_id, year) DO UPDATE SET days_present = EXCLUDED.days_present,
		 days_morning_only = EXCLUDED.days_morning_only, days_evening_only = EXCLUDED.days_evening_only,
		 last_updated = now()`,
		[personId, day]
	);
}

// Marks the worker present or not for this photo's shift slot (start or end) on its date.
async function setSlot(client: PoolClient, personId: string, session: Session, present: boolean) {
	const column = session.session_type === 'morning' ? 'morning_matched' : 'evening_matched';
	if (present) {
		await client.query(
			`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, ${column})
			 VALUES ($1, $2, $3, true)
			 ON CONFLICT (person_id, session_date) DO UPDATE SET ${column} = true, updated_at = now()`,
			[personId, session.pump_id, session.session_date]
		);
	} else {
		await client.query(
			`UPDATE daily_person_attendance SET ${column} = false, updated_at = now()
			 WHERE person_id = $1 AND session_date = $2`,
			[personId, session.session_date]
		);
		await client.query(
			`DELETE FROM daily_person_attendance
			 WHERE person_id = $1 AND session_date = $2 AND NOT morning_matched AND NOT evening_matched`,
			[personId, session.session_date]
		);
	}
	await recalculateYear(client, personId, session.session_date);
}

// A worker left with no face, photo or day after a move was only ever that one wrong face.
async function retireIfEmpty(client: PoolClient, personId: string) {
	await client.query(
		`UPDATE persons SET status = 'archived'
		 WHERE id = $1 AND status IN ('active', 'pending_review')
		   AND NOT EXISTS (SELECT 1 FROM attendance_face_evidence WHERE person_id = $1)
		   AND NOT EXISTS (SELECT 1 FROM person_face_vectors WHERE person_id = $1)
		   AND NOT EXISTS (SELECT 1 FROM daily_person_attendance WHERE person_id = $1)`,
		[personId]
	);
}

// A plant manager's fix is logged with no admin and the manager in `by`.
async function audit(
	client: PoolClient,
	by: string | FixActor,
	action: string,
	targetId: string,
	details: Record<string, unknown>
) {
	const actor: FixActor = typeof by === 'string' ? { role: 'admin', id: by } : by;
	await client.query(
		`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
		 VALUES ($1, $2, 'attendance_session', $3, $4)`,
		[
			actor.role === 'admin' ? actor.id : null,
			action,
			targetId,
			JSON.stringify(actor.role === 'admin' ? details : { ...details, by: actor })
		]
	);
}

// The face counted for `fromPersonId` in this photo belongs to `toPersonId`, or to a new worker
// when toPersonId is null (optional `name`). The face, its evidence and the shift slot move; the
// admin or plant manager has looked at it, so it joins the new worker's gallery.
export async function moveFace(
	client: PoolClient,
	input: {
		sessionId: string;
		fromPersonId: string;
		toPersonId: string | null;
		name?: unknown;
		actor: FixActor;
	}
): Promise<{ personId: string; createdPerson: boolean }> {
	const session = await lockSession(client, input.sessionId);
	if (!(await inPhoto(client, session.id, input.fromPersonId))) {
		throw new FaceFixError('This worker has no face in that photo.');
	}
	let personId = input.toPersonId;
	const createdPerson = !personId;
	if (personId) {
		if (personId === input.fromPersonId) throw new FaceFixError('Choose a different worker.');
		await lockPumpWorker(client, personId, session.pump_id);
		if (await inPhoto(client, session.id, personId)) {
			throw new FaceFixError('That worker already has a face in this photo.');
		}
	} else {
		personId = await createWorker(client, session.pump_id, input.name, input.actor.role);
	}

	await client.query(
		`UPDATE attendance_face_evidence SET person_id = $3, match_confidence = NULL
		 WHERE session_id = $1 AND person_id = $2`,
		[session.id, input.fromPersonId, personId]
	);
	await client.query(
		`UPDATE person_face_vectors SET person_id = $3, in_gallery = true, is_anchor = $4
		 WHERE session_id = $1 AND person_id = $2`,
		[session.id, input.fromPersonId, personId, createdPerson]
	);
	await setSlot(client, input.fromPersonId, session, false);
	await setSlot(client, personId, session, true);
	await trimGallery(client, personId);
	await retireIfEmpty(client, input.fromPersonId);
	await audit(client, input.actor, 'move_face', session.id, {
		from_person_id: input.fromPersonId,
		to_person_id: personId,
		created_person: createdPerson
	});
	return { personId, createdPerson };
}

// Counts a worker the camera missed for this photo: an existing worker of the pump, or a new one
// named `name`. There is no face, so nothing is added to any gallery.
export async function markPresent(
	client: PoolClient,
	input: { sessionId: string; personId: string | null; name?: unknown; actor: FixActor }
): Promise<{ personId: string; createdPerson: boolean }> {
	const session = await lockSession(client, input.sessionId);
	let personId = input.personId;
	const createdPerson = !personId;
	if (personId) {
		await lockPumpWorker(client, personId, session.pump_id);
		if (await inPhoto(client, session.id, personId)) {
			throw new FaceFixError('That worker is already counted in this photo.');
		}
	} else {
		if (!input.name) throw new FaceFixError("Enter the new worker's name.");
		personId = await createWorker(client, session.pump_id, input.name, input.actor.role);
	}
	await client.query(
		'INSERT INTO attendance_face_evidence (session_id, person_id) VALUES ($1, $2)',
		[session.id, personId]
	);
	await setSlot(client, personId, session, true);
	await audit(client, input.actor, 'mark_present', session.id, {
		person_id: personId,
		created_person: createdPerson
	});
	return { personId, createdPerson };
}

export type FixActor = { role: 'admin' | 'plant-manager'; id: string };

// Merges two workers of one pump who are the same person: the merged worker's days and faces go
// to the kept worker (a day present in either counts), the merged worker is marked merged, and
// the kept worker takes the name if it had none. Face evidence stays where it was, so the merge
// can be undone (undoMerge); the session logs show the kept worker for it.
export async function mergeWorkers(
	client: PoolClient,
	input: { keptId: string; mergedId: string; actor: FixActor; similarity?: number | null }
) {
	const { keptId, mergedId, actor } = input;
	if (keptId === mergedId) throw new FaceFixError('Pick two different workers.');
	const { rows } = await client.query(
		`SELECT id, pump_id, name, named_by, is_operator FROM persons
		 WHERE id = ANY($1::uuid[]) AND status IN ('active', 'pending_review')
		 FOR UPDATE`,
		[[keptId, mergedId]]
	);
	const kept = rows.find((row) => row.id === keptId);
	const merged = rows.find((row) => row.id === mergedId);
	if (!kept || !merged || kept.pump_id !== merged.pump_id) {
		throw new FaceFixError('These workers were changed meanwhile. Reload the page.');
	}
	const { rows: days } = await client.query<{ day: string }>(
		`SELECT session_date::text AS day FROM daily_person_attendance WHERE person_id = $1`,
		[mergedId]
	);
	await client.query(
		`INSERT INTO daily_person_attendance
		   (person_id, pump_id, session_date, morning_matched, evening_matched,
		    morning_confidence, evening_confidence, updated_at)
		 SELECT $1, pump_id, session_date, morning_matched, evening_matched,
		        morning_confidence, evening_confidence, now()
		 FROM daily_person_attendance WHERE person_id = $2
		 ON CONFLICT (person_id, session_date) DO UPDATE SET
		   morning_matched = daily_person_attendance.morning_matched OR EXCLUDED.morning_matched,
		   evening_matched = daily_person_attendance.evening_matched OR EXCLUDED.evening_matched,
		   morning_confidence = GREATEST(daily_person_attendance.morning_confidence, EXCLUDED.morning_confidence),
		   evening_confidence = GREATEST(daily_person_attendance.evening_confidence, EXCLUDED.evening_confidence),
		   updated_at = now()`,
		[keptId, mergedId]
	);
	await client.query('DELETE FROM daily_person_attendance WHERE person_id = $1', [mergedId]);
	await client.query('UPDATE person_face_vectors SET person_id = $1 WHERE person_id = $2', [
		keptId,
		mergedId
	]);
	await trimGallery(client, keptId);
	await client.query(
		`UPDATE persons SET status = 'merged', merged_into_person_id = $1 WHERE id = $2`,
		[keptId, mergedId]
	);
	await client.query(
		`UPDATE persons SET is_operator = is_operator OR $2::boolean,
		        named_at = CASE WHEN name IS NULL AND $3::text IS NOT NULL THEN now() ELSE named_at END,
		        named_by = CASE WHEN name IS NULL THEN $4::text ELSE named_by END,
		        name = COALESCE(name, $3::text)
		 WHERE id = $1`,
		[keptId, merged.is_operator, merged.name, merged.named_by]
	);
	const isAdmin = actor.role === 'admin';
	await client.query(
		`INSERT INTO person_merge_log
		   (kept_person_id, merged_person_id, admin_id, merged_by_manager_id, similarity_score)
		 VALUES ($1, $2, $3, $4, $5)`,
		[
			keptId,
			mergedId,
			isAdmin ? actor.id : null,
			isAdmin ? null : actor.id,
			input.similarity ?? null
		]
	);
	if (isAdmin) {
		const [lower, higher] = [keptId, mergedId].sort();
		await client.query(
			`INSERT INTO merge_review_decisions
			   (lower_person_id, higher_person_id, decision, reviewed_by_admin_id, similarity_score)
			 VALUES ($1, $2, 'merged', $3, $4)
			 ON CONFLICT (lower_person_id, higher_person_id) DO UPDATE SET decision = 'merged',
			   reviewed_by_admin_id = EXCLUDED.reviewed_by_admin_id,
			   similarity_score = EXCLUDED.similarity_score, reviewed_at = now()`,
			[lower, higher, actor.id, input.similarity ?? null]
		);
	}
	for (const year of new Set(days.map(({ day }) => day.slice(0, 4)))) {
		await recalculateYear(client, keptId, `${year}-01-01`);
		await recalculateYear(client, mergedId, `${year}-01-01`);
	}
	return { pumpId: kept.pump_id as string };
}

// Reverses a merge: the merged worker is active again and gets back the faces and shift slots of
// the photos they were in (merge never moved their evidence rows, so those say which photos).
// Days the admin had marked by hand stay with the kept worker. The pair is not suggested again.
export async function undoMerge(client: PoolClient, mergeLogId: string, adminId: string) {
	const { rows } = await client.query(
		`SELECT l.kept_person_id, l.merged_person_id, l.reversed_at, m.status, m.merged_into_person_id,
		        m.pump_id, m.name
		 FROM person_merge_log l JOIN persons m ON m.id = l.merged_person_id
		 WHERE l.id = $1 FOR UPDATE OF l, m`,
		[mergeLogId]
	);
	const log = rows[0];
	if (!log) throw new FaceFixError('Merge not found.');
	if (log.reversed_at) throw new FaceFixError('This merge was already undone.');
	if (log.status !== 'merged' || log.merged_into_person_id !== log.kept_person_id) {
		throw new FaceFixError('This worker was changed after the merge; it cannot be undone here.');
	}
	const kept = log.kept_person_id as string;
	const merged = log.merged_person_id as string;

	await client.query(
		`UPDATE persons SET status = 'active', merged_into_person_id = NULL WHERE id = $1`,
		[merged]
	);

	const { rows: sessions } = await client.query<Session>(
		`SELECT s.id, s.pump_id, s.session_date::text AS session_date, s.session_type
		 FROM attendance_face_evidence e JOIN attendance_sessions s ON s.id = e.session_id
		 WHERE e.person_id = $1`,
		[merged]
	);
	for (const session of sessions) {
		if (!(await inPhoto(client, session.id, kept))) {
			await client.query(
				`UPDATE person_face_vectors SET person_id = $2 WHERE person_id = $1 AND session_id = $3`,
				[kept, merged, session.id]
			);
			await setSlot(client, kept, session, false);
		}
		await setSlot(client, merged, session, true);
	}
	await trimGallery(client, kept);
	await trimGallery(client, merged);

	await client.query(
		`UPDATE person_merge_log SET reversed_at = now(), reversed_by_admin_id = $2 WHERE id = $1`,
		[mergeLogId, adminId]
	);
	await client.query(
		`UPDATE merge_review_decisions SET decision = 'dismissed', reviewed_by_admin_id = $3,
		        reviewed_at = now()
		 WHERE lower_person_id = LEAST($1::uuid, $2::uuid)
		   AND higher_person_id = GREATEST($1::uuid, $2::uuid)`,
		[kept, merged, adminId]
	);
	await client.query(
		`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
		 VALUES ($1, 'undo_merge', 'person', $2, $3)`,
		[adminId, merged, JSON.stringify({ kept_person_id: kept, photos: sessions.length })]
	);
	return { keptPersonId: kept, mergedPersonId: merged, photos: sessions.length };
}

// Removes one worker for good (e.g. someone photographed only to test): their faces, days, totals,
// flags and merge history go, along with any worker merged into them (the same person). The shift
// photos stay; they hold other workers too. The removal is audited with what it deleted.
export async function removeWorker(client: PoolClient, personId: string, adminId: string) {
	const { rows: people } = await client.query<{ id: string; pump_id: string; name: string | null }>(
		`WITH RECURSIVE gone AS (
		   SELECT id FROM persons WHERE id = $1
		   UNION SELECT p.id FROM persons p JOIN gone g ON p.merged_into_person_id = g.id
		 )
		 SELECT p.id, p.pump_id, p.name FROM persons p JOIN gone USING (id) FOR UPDATE OF p`,
		[personId]
	);
	if (!people.length) throw new FaceFixError('Worker not found.');
	const ids = people.map((person) => person.id);
	const counts: Record<string, number> = {};
	const remove = async (table: string, where: string) => {
		const result = await client.query(`DELETE FROM ${table} WHERE ${where}`, [ids]);
		counts[table] = result.rowCount ?? 0;
	};
	await client.query(
		`UPDATE fraud_flags SET resolved_person_id = NULL WHERE resolved_person_id = ANY($1)`,
		[ids]
	);
	await client.query(
		`UPDATE attendance_review_flags SET resolved_person_id = NULL WHERE resolved_person_id = ANY($1)`,
		[ids]
	);
	await remove('person_face_vectors', 'person_id = ANY($1)');
	await remove('attendance_face_evidence', 'person_id = ANY($1)');
	await remove('daily_person_attendance', 'person_id = ANY($1)');
	await remove('person_attendance_yearly', 'person_id = ANY($1)');
	await remove('fraud_flags', 'person_id = ANY($1)');
	await remove('attendance_review_flags', 'person_id = ANY($1)');
	await remove('attendance_corrections', 'person_id = ANY($1)');
	await remove(
		'attendance_duplicate_resolutions',
		'kept_person_id = ANY($1) OR duplicate_person_id = ANY($1)'
	);
	await remove('person_merge_log', 'kept_person_id = ANY($1) OR merged_person_id = ANY($1)');
	await remove('merge_review_decisions', 'lower_person_id = ANY($1) OR higher_person_id = ANY($1)');
	await client.query(
		`UPDATE persons SET merged_into_person_id = NULL WHERE merged_into_person_id = ANY($1)`,
		[ids]
	);
	await remove('persons', 'id = ANY($1)');
	await client.query(
		`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
		 VALUES ($1, 'remove_worker', 'person', $2, $3)`,
		[
			adminId,
			personId,
			JSON.stringify({ pump_id: people[0].pump_id, name: people[0].name, removed: ids, counts })
		]
	);
	return { pumpId: people[0].pump_id, removed: ids.length, days: counts.daily_person_attendance };
}

export type FlagFix =
	| { action: 'move'; personId: string }
	| { action: 'new_worker'; name?: unknown }
	| { action: 'mark_present'; personId: string | null; name?: unknown }
	| { action: 'dismiss' };

const RESOLUTION = {
	move: 'moved',
	new_worker: 'new_worker',
	mark_present: 'marked_present',
	dismiss: 'dismissed'
} as const;

// Closes an admin's "Flag error" with what was done about it.
export async function resolveReviewFlag(
	client: PoolClient,
	flagId: string,
	adminId: string,
	fix: FlagFix
) {
	const { rows } = await client.query(
		`SELECT id, session_id, person_id, status FROM attendance_review_flags WHERE id = $1 FOR UPDATE`,
		[flagId]
	);
	const flag = rows[0];
	if (!flag) throw new FaceFixError('Flagged error not found.');
	if (flag.status !== 'open') throw new FaceFixError('This flagged error is already closed.');

	let personId: string | null = null;
	if (fix.action === 'move' || fix.action === 'new_worker') {
		if (!flag.person_id) throw new FaceFixError('This flag is not about one face.');
		if (fix.action === 'move' && !fix.personId) throw new FaceFixError('Choose the right worker.');
		({ personId } = await moveFace(client, {
			sessionId: flag.session_id,
			fromPersonId: flag.person_id,
			toPersonId: fix.action === 'move' ? fix.personId : null,
			name: fix.action === 'new_worker' ? fix.name : undefined,
			actor: { role: 'admin', id: adminId }
		}));
	} else if (fix.action === 'mark_present') {
		({ personId } = await markPresent(client, {
			sessionId: flag.session_id,
			personId: fix.personId,
			name: fix.name,
			actor: { role: 'admin', id: adminId }
		}));
	}

	await client.query(
		`UPDATE attendance_review_flags
		 SET status = 'resolved', resolution = $2, resolved_by_admin_id = $3, resolved_at = now(),
		     resolved_person_id = $4
		 WHERE id = $1`,
		[flagId, RESOLUTION[fix.action], adminId, personId]
	);
	return { personId };
}
