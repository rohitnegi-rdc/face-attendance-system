import type { Actions, PageServerLoad } from './$types';
import { query, queryOne } from '$lib/server/db';
import { error, fail, redirect } from '@sveltejs/kit';
import { createAttendanceReviewFlag } from '$lib/server/attendanceReview';
import { shiftStillOpen } from '$lib/server/shiftSessions';
import { renamePerson } from '$lib/server/personNames';
import { moveFace, removeWorker, undoMerge } from '$lib/server/faceFixes';
import { formText, runFaceFix } from '$lib/server/faceFixActions';
import { pumpWorkers } from '$lib/server/pumpWorkers';
import { personDisplayLabel } from '$lib/personLabel';
import { resolve } from '$app/paths';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const load: PageServerLoad = async ({ params }) => {
	const person = await queryOne<any>(
		`SELECT p.id, p.display_seq, p.name, p.is_operator, p.first_seen_at, p.last_seen_at, p.status,
		        pu.id AS pump_id, pu.pump_code
		 FROM persons p JOIN pumps pu ON pu.id = p.pump_id
		 WHERE p.id = $1`,
		[params.id]
	);
	if (!person) throw error(404, 'person not found');

	const history = await query<any>(
		`SELECT dpa.session_date, dpa.morning_matched, dpa.evening_matched,
		        dpa.morning_confidence, dpa.evening_confidence,
		        morning.id AS morning_session_id, morning.photo_url AS morning_photo_url,
		        morning_evidence.face_crop_url AS morning_crop_url,
		        morning_evidence.person_id IS NOT NULL AS morning_in_photo,
		        evening.id AS evening_session_id, evening.photo_url AS evening_photo_url,
		        evening_evidence.face_crop_url AS evening_crop_url,
		        evening_evidence.person_id IS NOT NULL AS evening_in_photo,
		        EXISTS (
		          SELECT 1 FROM attendance_review_flags arf
		          WHERE arf.session_id = morning.id AND arf.person_id IS NULL AND arf.status = 'open'
		        ) AS morning_group_flagged,
		        EXISTS (
		          SELECT 1 FROM attendance_review_flags arf
		          WHERE arf.session_id = morning.id AND arf.person_id = dpa.person_id
		            AND arf.status = 'open'
		        ) AS morning_person_flagged,
		        EXISTS (
		          SELECT 1 FROM attendance_review_flags arf
		          WHERE arf.session_id = evening.id AND arf.person_id IS NULL AND arf.status = 'open'
		        ) AS evening_group_flagged,
		        EXISTS (
		          SELECT 1 FROM attendance_review_flags arf
		          WHERE arf.session_id = evening.id AND arf.person_id = dpa.person_id
		            AND arf.status = 'open'
		        ) AS evening_person_flagged
		 FROM daily_person_attendance dpa
		 LEFT JOIN attendance_sessions morning
		   ON morning.pump_id = dpa.pump_id AND morning.session_date = dpa.session_date
		  AND morning.session_type = 'morning'
		 LEFT JOIN attendance_face_evidence morning_evidence
		   ON morning_evidence.session_id = morning.id AND morning_evidence.person_id = dpa.person_id
		 LEFT JOIN attendance_sessions evening
		   ON evening.pump_id = dpa.pump_id AND evening.session_date = dpa.session_date
		  AND evening.session_type = 'evening'
		 LEFT JOIN attendance_face_evidence evening_evidence
		   ON evening_evidence.session_id = evening.id AND evening_evidence.person_id = dpa.person_id
		 WHERE dpa.person_id = $1
		 ORDER BY dpa.session_date DESC LIMIT 90`,
		[params.id]
	);

	const yearly = await query<any>(
		`SELECT EXTRACT(YEAR FROM session_date)::integer AS year,
		        COUNT(*) FILTER (WHERE morning_matched AND evening_matched) AS days_present,
		        COUNT(*) FILTER (
		          WHERE morning_matched AND NOT evening_matched
		            AND NOT ${shiftStillOpen('daily_person_attendance')}
		        ) AS days_morning_only,
		        COUNT(*) FILTER (WHERE NOT morning_matched AND evening_matched) AS days_evening_only
		 FROM daily_person_attendance
		 WHERE person_id = $1
		 GROUP BY EXTRACT(YEAR FROM session_date)
		 ORDER BY year DESC`,
		[params.id]
	);

	// Merges into or of this worker, newest first, so a wrong one can be undone (faceFixes.ts).
	const merges = await query<any>(
		`SELECT l.id, l.kept_person_id, l.merged_person_id, l.merged_at, l.reversed_at,
		        adm.email AS merged_by, other.display_seq, other.name, other.is_operator,
		        merged.status AS merged_status, merged.merged_into_person_id
		 FROM person_merge_log l
		 JOIN persons other
		   ON other.id = CASE WHEN l.kept_person_id = $1 THEN l.merged_person_id ELSE l.kept_person_id END
		 JOIN persons merged ON merged.id = l.merged_person_id
		 LEFT JOIN admins adm ON adm.id = l.admin_id
		 WHERE l.kept_person_id = $1 OR l.merged_person_id = $1
		 ORDER BY l.merged_at DESC LIMIT 20`,
		[params.id]
	);

	// The workers each of this worker's faces could be moved to.
	const workers = await pumpWorkers(
		[person.pump_id],
		history.flatMap((row: any) => [row.morning_session_id, row.evening_session_id]).filter(Boolean)
	);
	const moveTargets: Record<string, ReturnType<typeof workers.forSession>> = {};
	for (const row of history) {
		for (const [sessionId, inPhoto] of [
			[row.morning_session_id, row.morning_in_photo],
			[row.evening_session_id, row.evening_in_photo]
		]) {
			if (sessionId && inPhoto)
				moveTargets[sessionId] = workers.forSession(person.pump_id, sessionId);
		}
	}

	return {
		person,
		history,
		yearly,
		moveTargets,
		merges: merges.map((merge) => ({
			...merge,
			intoThis: merge.kept_person_id === params.id,
			other: personDisplayLabel(person.pump_code, merge.display_seq, merge.is_operator, merge.name),
			canUndo:
				!merge.reversed_at &&
				merge.merged_status === 'merged' &&
				merge.merged_into_person_id === merge.kept_person_id
		}))
	};
};

export const actions: Actions = {
	// The admin corrects the name the operator wrote (audited in admin_audit_log).
	rename: async ({ request, params, locals }) => {
		const form = await request.formData();
		const result = await renamePerson(
			{ role: 'admin', id: locals.user!.id },
			params.id,
			form.get('name')
		);
		if (result.error) return fail(result.status, { success: false, message: result.error });
		return { success: true, message: 'Name saved' };
	},
	// This worker's face in one photo is someone else's: move it to that worker or a new one.
	moveFace: async ({ request, params, locals }) => {
		const form = await request.formData();
		const sessionId = formText(form, 'session_id');
		const toPersonId = formText(form, 'person_id') || null;
		if (!UUID_PATTERN.test(sessionId) || (toPersonId && !UUID_PATTERN.test(toPersonId))) {
			return fail(400, { success: false, message: 'Invalid request.' });
		}
		return runFaceFix('move_face', locals.user!.id, async (client) => {
			const result = await moveFace(client, {
				sessionId,
				fromPersonId: params.id,
				toPersonId,
				name: formText(form, 'name'),
				adminId: locals.user!.id
			});
			return result.createdPerson
				? 'Face moved to a new worker, who is marked present for that photo.'
				: 'Face moved. The other worker is marked present for that photo.';
		});
	},
	undoMerge: async ({ request, locals }) => {
		const mergeId = formText(await request.formData(), 'merge_id');
		if (!UUID_PATTERN.test(mergeId))
			return fail(400, { success: false, message: 'Invalid request.' });
		return runFaceFix('undo_merge', locals.user!.id, async (client) => {
			const result = await undoMerge(client, mergeId, locals.user!.id);
			return `Merge undone. The two workers are separate again; ${result.photos} photo(s) went back.`;
		});
	},
	// Removes this worker for good (a test photo, someone who is not a worker); audited.
	removeWorker: async ({ params, locals }) => {
		let pumpId = '';
		const result = await runFaceFix('remove_worker', locals.user!.id, async (client) => {
			pumpId = (await removeWorker(client, params.id, locals.user!.id)).pumpId;
			return 'Worker removed.';
		});
		if (!pumpId || !('success' in result) || !result.success) return result;
		redirect(303, resolve(`/admin/pumps/${pumpId}`));
	},
	flagEvidence: async ({ params, request, locals }) => {
		const form = await request.formData();
		const person = await queryOne<any>('SELECT pump_id FROM persons WHERE id = $1', [params.id]);
		if (!person) return fail(404, { message: 'Person not found.' });
		const requestedPersonId = String(form.get('person_id') || '');
		if (requestedPersonId && requestedPersonId !== params.id) {
			return fail(400, { message: 'Invalid person evidence.' });
		}

		try {
			const created = await createAttendanceReviewFlag({
				sessionId: String(form.get('session_id') || ''),
				personId: requestedPersonId || null,
				pumpId: person.pump_id,
				adminId: locals.user!.id,
				reason: String(form.get('reason') || ''),
				note: String(form.get('note') || '')
			});
			return {
				success: true,
				message: !created
					? 'This attendance evidence is already flagged.'
					: form.get('reason') === 'incorrect_match'
						? 'Flagged for review. This face no longer helps recognise this worker.'
						: 'Attendance evidence flagged for review.'
			};
		} catch (actionError) {
			return fail(400, {
				message: actionError instanceof Error ? actionError.message : 'Could not flag evidence.'
			});
		}
	}
};
