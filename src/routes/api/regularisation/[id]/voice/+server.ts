import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { voiceFile } from '$lib/server/regularisation';

// The voice note of a regularisation request, for a login that may see the pump.
export const GET: RequestHandler = async ({ params, locals }) => {
	const user = locals.user;
	if (!user) return error(401, 'Unauthorized');
	if (user.role === 'vendor') return error(404, 'Voice note not found');
	const file = await voiceFile(params.id, { role: user.role, id: user.id });
	if (!file) return error(404, 'Voice note not found');
	return new Response(new Uint8Array(file.bytes), {
		headers: { 'content-type': file.type, 'cache-control': 'private, max-age=3600' }
	});
};
