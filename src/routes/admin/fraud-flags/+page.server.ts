import type { PageServerLoad, Actions } from './$types';
import { query } from '$lib/server/db';

export const load: PageServerLoad = async () => {
	const flags = await query<any>(
		`SELECT ff.*, p.display_seq, pu1.pump_code AS flagged_at_pump, pu2.pump_code AS matched_at_pump
		 FROM fraud_flags ff
		 JOIN persons p ON p.id = ff.person_id
		 JOIN attendance_sessions s ON s.id = ff.session_id
		 JOIN pumps pu1 ON pu1.id = s.pump_id
		 JOIN pumps pu2 ON pu2.id = ff.matched_at_pump_id
		 ORDER BY ff.created_at DESC LIMIT 200`
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
