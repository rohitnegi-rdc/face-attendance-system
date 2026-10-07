import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const isHttps = request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
	cookies.delete(isHttps ? 'session' : 'session_http', { path: '/', secure: isHttps });
	throw redirect(303, '/login');
};
