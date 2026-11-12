import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readDecisionLink, voiceFile } from '$lib/server/regularisation';

// The voice note, opened from the email's decision page (the signed link stands in for a sign-in).
export const GET: RequestHandler = async ({ params }) => {
	const link = await readDecisionLink(params.token);
	if (!link?.allowed) return error(404, 'Voice note not found');
	const file = await voiceFile(link.facts.id, null);
	if (!file) return error(404, 'Voice note not found');
	return new Response(new Uint8Array(file.bytes), {
		headers: { 'content-type': file.type, 'cache-control': 'private, max-age=3600' }
	});
};
