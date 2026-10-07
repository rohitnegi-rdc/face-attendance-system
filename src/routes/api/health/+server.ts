import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pool } from '$lib/server/db';

export const GET: RequestHandler = async () => {
	try {
		await pool.query('SELECT 1');
		return json({ status: 'ok', database: 'ok' });
	} catch {
		return json({ status: 'unavailable', database: 'unavailable' }, { status: 503 });
	}
};
