import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'node:fs/promises';
import path from 'node:path';
import { queryOne } from '$lib/server/db';

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) return error(401, 'Unauthorized');

	const session = await queryOne<any>(
		'SELECT pump_id, photo_url FROM attendance_sessions WHERE id = $1',
		[params.id]
	);
	if (!session?.photo_url) return error(404, 'Photo not found');
	if (locals.user.role === 'pump' && session.pump_id !== locals.user.id) {
		return error(403, 'Forbidden');
	}

	const photoPath = path.resolve(session.photo_url);
	const relative = path.relative(UPLOAD_DIR, photoPath);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return error(403, 'Invalid photo path');
	}

	try {
		const data = await fs.readFile(photoPath);
		const extension = path.extname(photoPath).toLowerCase();
		const contentType =
			extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
		return new Response(data, {
			headers: {
				'content-type': contentType,
				'cache-control': 'private, max-age=300',
				'x-content-type-options': 'nosniff'
			}
		});
	} catch {
		return error(404, 'Photo not found');
	}
};
