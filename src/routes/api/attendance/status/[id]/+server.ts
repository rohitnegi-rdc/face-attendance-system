import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query, queryOne } from '$lib/server/db';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const session = await queryOne<any>('SELECT * FROM attendance_sessions WHERE id = $1', [params.id]);
	if (!session) return error(404, 'session not found');

	if (locals.user.role === 'pump' && session.pump_id !== locals.user.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const matched = await query<any>(
		`SELECT p.id AS person_id, p.display_seq, pu.pump_code, dpa.morning_matched, dpa.evening_matched,
		        pfv.source_photo_crop_url
		 FROM daily_person_attendance dpa
		 JOIN persons p ON p.id = dpa.person_id
		 JOIN pumps pu ON pu.id = p.pump_id
		 LEFT JOIN LATERAL (
		   SELECT source_photo_crop_url FROM person_face_vectors
		   WHERE person_id = p.id ORDER BY created_at DESC LIMIT 1
		 ) pfv ON true
		 WHERE dpa.pump_id = $1 AND dpa.session_date = $2
		   AND p.first_seen_at < $3`,
		[session.pump_id, session.session_date, session.processed_at || new Date()]
	);

	const newPersons = await query<any>(
		`SELECT p.id AS person_id, p.display_seq, pu.pump_code, p.first_seen_at
		 FROM persons p JOIN pumps pu ON pu.id = p.pump_id
		 WHERE p.pump_id = $1 AND p.first_seen_at >= $2`,
		[session.pump_id, session.submitted_at]
	);

	const fraudFlags = await query<any>(
		`SELECT ff.*, p2.pump_id AS other_pump_id FROM fraud_flags ff
		 LEFT JOIN attendance_sessions p2 ON p2.id = ff.matched_session_id
		 WHERE ff.session_id = $1`,
		[session.id]
	);

	return json({
		session_id: session.id,
		status: session.status,
		session_type: session.session_type,
		session_date: session.session_date,
		error_reason: session.error_reason,
		matched,
		new_persons: newPersons,
		fraud_flags: fraudFlags
	});
};
