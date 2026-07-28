import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query, queryOne } from '$lib/server/db';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const session = await queryOne<any>('SELECT * FROM attendance_sessions WHERE id = $1', [
		params.id
	]);
	if (!session) return error(404, 'session not found');

	if (locals.user.role === 'pump' && session.pump_id !== locals.user.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const matched = await query<any>(
		`SELECT p.id AS person_id, p.display_seq, pu.pump_code, dpa.morning_matched, dpa.evening_matched,
		        pfv.source_photo_crop_url
		 FROM person_face_vectors current_vector
		 JOIN persons p ON p.id = current_vector.person_id
		 JOIN pumps pu ON pu.id = p.pump_id
		 JOIN daily_person_attendance dpa
		   ON dpa.person_id = p.id AND dpa.session_date = $2
		 LEFT JOIN person_face_vectors pfv ON pfv.id = current_vector.id
		 WHERE current_vector.session_id = $1
		   AND p.first_seen_at < $3
		 GROUP BY p.id, p.display_seq, pu.pump_code, dpa.morning_matched,
		          dpa.evening_matched, pfv.source_photo_crop_url`,
		[session.id, session.session_date, session.submitted_at]
	);

	const newPersons = await query<any>(
		`SELECT p.id AS person_id, p.display_seq, pu.pump_code, p.first_seen_at,
		        MIN(pfv.source_photo_crop_url) AS source_photo_crop_url
		 FROM person_face_vectors pfv
		 JOIN persons p ON p.id = pfv.person_id
		 JOIN pumps pu ON pu.id = p.pump_id
		 WHERE pfv.session_id = $1 AND p.first_seen_at >= $2
		 GROUP BY p.id, p.display_seq, pu.pump_code, p.first_seen_at`,
		[session.id, session.submitted_at]
	);

	const fraudFlags = await query<any>(
		`SELECT ff.id, ff.similarity_score, ff.created_at,
		        other_pump.id AS other_pump_id, other_pump.pump_code AS other_pump_code,
		        other_plant.name AS other_plant_name,
		        source_pump.pump_code AS pump_code, p.display_seq,
		        concat(source_pump.pump_code, ' Worker ', p.display_seq) AS person_label,
		        matched_session.submitted_at AS matched_submitted_at,
		        pfv.source_photo_crop_url
		 FROM fraud_flags ff
		 JOIN persons p ON p.id = ff.person_id
		 JOIN pumps source_pump ON source_pump.id = p.pump_id
		 JOIN attendance_sessions matched_session ON matched_session.id = ff.matched_session_id
		 JOIN pumps other_pump ON other_pump.id = matched_session.pump_id
		 JOIN plants other_plant ON other_plant.id = other_pump.plant_id
		 LEFT JOIN LATERAL (
		   SELECT source_photo_crop_url FROM person_face_vectors
		   WHERE person_id = p.id ORDER BY created_at DESC LIMIT 1
		 ) pfv ON true
		 WHERE ff.session_id = $1`,
		[session.id]
	);

	const unknownFaces = await query<any>(
		`SELECT id, face_crop_url, created_at
		 FROM flagged_guests
		 WHERE session_id = $1
		 ORDER BY created_at`,
		[session.id]
	);

	return json({
		session_id: session.id,
		status: session.status,
		session_type: session.session_type,
		session_date: session.session_date,
		submitted_at: session.submitted_at,
		processed_at: session.processed_at,
		photo_url: session.photo_url ? `/api/attendance/photo/${session.id}` : null,
		error_reason: session.error_reason,
		matched,
		new_persons: newPersons,
		unknown_faces: unknownFaces,
		fraud_flags: fraudFlags
	});
};
