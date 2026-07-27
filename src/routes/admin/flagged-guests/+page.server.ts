import type { PageServerLoad, Actions } from './$types';
import { query, queryOne } from '$lib/server/db';

export const load: PageServerLoad = async () => {
	const guests = await query<any>(
		`SELECT fg.*, s.pump_id FROM flagged_guests fg
		 JOIN attendance_sessions s ON s.id = fg.session_id
		 WHERE fg.reviewed = false ORDER BY fg.created_at DESC LIMIT 200`
	);
	return { guests };
};

export const actions: Actions = {
	promote: async ({ request }) => {
		const form = await request.formData();
		const id = form.get('id') as string;
		const guest = await queryOne<any>(
			`SELECT fg.*, s.pump_id FROM flagged_guests fg JOIN attendance_sessions s ON s.id = fg.session_id WHERE fg.id = $1`,
			[id]
		);
		if (!guest) return;
		const person = await queryOne<any>(
			`INSERT INTO persons (pump_id, status, display_seq)
			 VALUES ($1, 'active', (SELECT COALESCE(MAX(display_seq), 0) + 1 FROM persons WHERE pump_id = $1))
			 RETURNING id`,
			[guest.pump_id]
		);
		await query(`INSERT INTO person_face_vectors (person_id, embedding, source_photo_crop_url) VALUES ($1, $2, $3)`, [
			person.id,
			guest.embedding,
			guest.face_crop_url
		]);
		await query('UPDATE flagged_guests SET reviewed = true WHERE id = $1', [id]);
	},
	dismiss: async ({ request }) => {
		const form = await request.formData();
		await query('UPDATE flagged_guests SET reviewed = true WHERE id = $1', [form.get('id')]);
	}
};
