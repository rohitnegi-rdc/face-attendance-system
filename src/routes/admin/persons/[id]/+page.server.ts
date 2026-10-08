import type { Actions, PageServerLoad } from './$types';
import { query, queryOne } from '$lib/server/db';
import { error, fail } from '@sveltejs/kit';
import { createAttendanceReviewFlag } from '$lib/server/attendanceReview';
import { shiftStillOpen } from '$lib/server/shiftSessions';

export const load: PageServerLoad = async ({ params }) => {
	const person = await queryOne<any>(
		`SELECT p.id, p.display_seq, p.first_seen_at, p.last_seen_at, p.status,
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
		        evening.id AS evening_session_id, evening.photo_url AS evening_photo_url,
		        evening_evidence.face_crop_url AS evening_crop_url,
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

	return { person, history, yearly };
};

export const actions: Actions = {
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
				message: created
					? 'Attendance evidence flagged for review.'
					: 'This attendance evidence is already flagged.'
			};
		} catch (actionError) {
			return fail(400, {
				message: actionError instanceof Error ? actionError.message : 'Could not flag evidence.'
			});
		}
	}
};
