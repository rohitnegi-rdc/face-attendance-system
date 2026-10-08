import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import type { RequestHandler } from './$types';
import { COOKIE_PATH } from '$lib/server/cookies';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const isHttps = request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
	cookies.delete(isHttps ? 'session' : 'session_http', { path: COOKIE_PATH, secure: isHttps });
	throw redirect(303, resolve('/login'));
};
