import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'node:fs/promises';
import path from 'node:path';
import { photoBackupFile } from '$lib/server/photoBackups';

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The untouched upload copy of a failed or fraud photo. Admin and plant managers only.
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) return error(401, 'Unauthorized');
	if (!UUID.test(params.id)) return error(404, 'Photo not found');

	const filePath = await photoBackupFile(params.id, locals.user);
	if (!filePath) return error(locals.user.role === 'pump' ? 403 : 404, 'Photo not found');

	const resolved = path.resolve(filePath);
	const relative = path.relative(UPLOAD_DIR, resolved);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return error(403, 'Invalid photo path');
	}

	try {
		const data = await fs.readFile(resolved);
		return new Response(data, {
			headers: {
				'content-type': 'image/jpeg',
				'cache-control': 'private, max-age=300',
				'x-content-type-options': 'nosniff'
			}
		});
	} catch {
		return error(404, 'Photo not found');
	}
};
