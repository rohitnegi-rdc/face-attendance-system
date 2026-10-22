import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { queryOne } from '$lib/server/db';
import { canSeePump, cropResponse } from '$lib/server/faceAccess';

// A worker's most recent face, as an image, for the People pages: they list names and load the
// face only when it is opened.
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) return error(401, 'Unauthorized');
	if (!/^[0-9a-f-]{36}$/i.test(params.id)) return error(404, 'Face not found');

	const person = await queryOne<any>(
		`SELECT pu.id AS pump_id, pu.vendor_id, pu.plant_id,
		        (SELECT source_photo_crop_url FROM person_face_vectors
		         WHERE person_id = p.id AND source_photo_crop_url IS NOT NULL
		         ORDER BY created_at DESC LIMIT 1) AS crop
		 FROM persons p JOIN pumps pu ON pu.id = p.pump_id WHERE p.id = $1`,
		[params.id]
	);
	if (!person || !(await canSeePump(locals.user, person))) return error(404, 'Face not found');
	return cropResponse(person.crop) ?? error(404, 'Face not found');
};
