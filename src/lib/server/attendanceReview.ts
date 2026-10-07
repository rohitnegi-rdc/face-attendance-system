import { queryOne } from '$lib/server/db';

const REVIEW_REASONS = new Set([
	'incorrect_match',
	'missing_person',
	'wrong_session',
	'poor_photo',
	'other'
]);

type CreateReviewFlagInput = {
	sessionId: string;
	personId?: string | null;
	pumpId: string;
	adminId: string;
	reason: string;
	note?: string;
};

export async function createAttendanceReviewFlag(input: CreateReviewFlagInput): Promise<boolean> {
	const note = input.note?.trim() || null;
	if (!REVIEW_REASONS.has(input.reason)) throw new Error('Choose a valid review reason.');
	if (note && note.length > 500) throw new Error('Review note must be 500 characters or fewer.');

	const evidence = await queryOne(
		`SELECT s.id
		 FROM attendance_sessions s
		 WHERE s.id = $1 AND s.pump_id = $2
		   AND (
		     $3::uuid IS NULL OR EXISTS (
		       SELECT 1 FROM attendance_face_evidence afe
		       WHERE afe.session_id = s.id AND afe.person_id = $3
		     )
		   )`,
		[input.sessionId, input.pumpId, input.personId || null]
	);
	if (!evidence) throw new Error('Attendance evidence was not found for this pump.');

	const existing = await queryOne(
		`SELECT id FROM attendance_review_flags
		 WHERE session_id = $1 AND person_id IS NOT DISTINCT FROM $2::uuid AND status = 'open'`,
		[input.sessionId, input.personId || null]
	);
	if (existing) return false;

	await queryOne(
		`INSERT INTO attendance_review_flags
		   (session_id, person_id, reason, note, flagged_by_admin_id)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		[input.sessionId, input.personId || null, input.reason, note, input.adminId]
	);
	return true;
}
