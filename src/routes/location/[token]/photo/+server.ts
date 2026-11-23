import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readLocationLink } from '$lib/server/locationDecision';

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');

// The shift start photo for the email link's page: only for the plant manager or monitor the link
// was sent to, while they still look after that pump.
export const GET: RequestHandler = async ({ params }) => {
	const link = await readLocationLink(params.token);
	if (!link?.allowed || !link.facts.photo_url) return error(404, 'Photo not found');
	const photoPath = path.resolve(String(link.facts.photo_url));
	const relative = path.relative(UPLOAD_DIR, photoPath);
	if (relative.startsWith('..') || path.isAbsolute(relative))
		return error(403, 'Invalid photo path');
	try {
		const data = await fs.readFile(photoPath);
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
