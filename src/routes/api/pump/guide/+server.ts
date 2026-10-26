import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pool } from '$lib/server/db';

// The pump finished the first sign-in guide: it stops opening by itself. The first finish
// time is kept; the Help button reopens the guide without calling this.
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user || locals.user.role !== 'pump') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}
	await pool.query(
		'UPDATE pumps SET guide_done_at = coalesce(guide_done_at, now()) WHERE id = $1',
		[locals.user.id]
	);
	return json({ ok: true });
};
