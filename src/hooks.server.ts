import type { Handle } from '@sveltejs/kit';
import { verifyToken } from '$lib/server/auth';

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get('session');
	const auth = token ? verifyToken(token) : null;
	event.locals.user = auth;

	const path = event.url.pathname;
	const guardedPrefix = (['/admin', '/vendor', '/pump'] as const).find((p) => path.startsWith(p));

	if (guardedPrefix) {
		const requiredRole = guardedPrefix.slice(1) as 'admin' | 'vendor' | 'pump';
		if (!auth) {
			return new Response(null, { status: 302, headers: { location: '/login' } });
		}
		if (auth.role !== requiredRole) {
			return new Response('Forbidden', { status: 403 });
		}
	}

	if (path.startsWith('/api/admin') && auth?.role !== 'admin') {
		return new Response(JSON.stringify({ error: 'Forbidden' }), {
			status: auth ? 403 : 401,
			headers: { 'content-type': 'application/json' }
		});
	}
	if (path.startsWith('/api/vendor') && auth?.role !== 'vendor' && auth?.role !== 'admin') {
		return new Response(JSON.stringify({ error: 'Forbidden' }), {
			status: auth ? 403 : 401,
			headers: { 'content-type': 'application/json' }
		});
	}
	if (
		path.startsWith('/api/attendance') &&
		path !== '/api/auth/login' &&
		auth?.role !== 'pump' &&
		auth?.role !== 'admin'
	) {
		return new Response(JSON.stringify({ error: 'Forbidden' }), {
			status: auth ? 403 : 401,
			headers: { 'content-type': 'application/json' }
		});
	}
	if (path.startsWith('/api/pump') && auth?.role !== 'pump' && auth?.role !== 'admin') {
		return new Response(JSON.stringify({ error: 'Forbidden' }), {
			status: auth ? 403 : 401,
			headers: { 'content-type': 'application/json' }
		});
	}

	return resolve(event);
};
