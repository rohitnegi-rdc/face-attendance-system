import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { queryOne } from '$lib/server/db';
import { canSeePump, cropResponse } from '$lib/server/faceAccess';

// One worker's face crop from a session (attendance_face_evidence.id), as an image. The session
// logs show workers as names and load the face only when it is opened, instead of putting every
// crop (about 17 KB of base64 each) into the page.
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) return error(401, 'Unauthorized');
	if (!/^[0-9a-f-]{36}$/i.test(params.id)) return error(404, 'Face not found');

	const face = await queryOne<any>(
		`SELECT afe.face_crop_url, pu.id AS pump_id, pu.vendor_id, pu.plant_id
		 FROM attendance_face_evidence afe
		 JOIN attendance_sessions s ON s.id = afe.session_id JOIN pumps pu ON pu.id = s.pump_id
		 WHERE afe.id = $1`,
		[params.id]
	);
	// Not found and not yours look the same, so ids cannot be probed.
	if (!face || !(await canSeePump(locals.user, face))) return error(404, 'Face not found');
	return cropResponse(face.face_crop_url) ?? error(404, 'Face not found');
};
