import type { PageServerLoad, Actions } from './$types';
import { query } from '$lib/server/db';

export const load: PageServerLoad = async () => {
	const flags = await query<any>(
		`SELECT ff.*, p.display_seq,
		        pu1.pump_code AS flagged_at_pump, pl1.name AS flagged_at_plant,
		        pu2.pump_code AS matched_at_pump, pl2.name AS matched_at_plant,
		        s.submitted_at AS flagged_submitted_at,
		        matched_session.submitted_at AS matched_submitted_at,
		        pfv.source_photo_crop_url
		 FROM fraud_flags ff
		 JOIN persons p ON p.id = ff.person_id
		 JOIN attendance_sessions s ON s.id = ff.session_id
		 JOIN pumps pu1 ON pu1.id = s.pump_id
		 JOIN plants pl1 ON pl1.id = pu1.plant_id
		 JOIN pumps pu2 ON pu2.id = ff.matched_at_pump_id
		 JOIN plants pl2 ON pl2.id = pu2.plant_id
		 JOIN attendance_sessions matched_session ON matched_session.id = ff.matched_session_id
		 LEFT JOIN LATERAL (
		   SELECT source_photo_crop_url FROM person_face_vectors
		   WHERE person_id = p.id ORDER BY created_at DESC LIMIT 1
		 ) pfv ON true
		 ORDER BY ff.reviewed ASC, ff.created_at DESC LIMIT 200`
	);
	return { flags };
};

export const actions: Actions = {
	review: async ({ request }) => {
		const form = await request.formData();
		const id = form.get('id');
		await query('UPDATE fraud_flags SET reviewed = true WHERE id = $1', [id]);
	}
};
