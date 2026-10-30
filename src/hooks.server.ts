import type { Handle, HandleServerError } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { base, resolve as resolvePath } from '$app/paths';
import { verifyToken } from '$lib/server/auth';
import { COOKIE_PATH } from '$lib/server/cookies';
import { queryOne } from '$lib/server/db';
import { logger } from '$lib/server/log';
import { CONTACT_ADMIN } from '$lib/errorMessages';

// Any exception no route handled. The user gets a short reference to quote to the admin; the
// details (stack, SQL error) stay in the server log under the same reference.
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	if (status === 404) return { message: 'Page not found.' };
	const errorId = randomUUID().slice(0, 8);
	logger.error(
		{
			errorId,
			status,
			method: event.request.method,
			path: event.url.pathname,
			error: error instanceof Error ? error.stack : String(error)
		},
		message
	);
	return { message: CONTACT_ADMIN, errorId };
};

export const handle: Handle = async ({ event, resolve }) => {
	const isHttps = event.request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
	const token = isHttps
		? event.cookies.get('session')
		: (event.cookies.get('session_http') ?? event.cookies.get('session'));
	let auth = token ? verifyToken(token) : null;
	// A plant-manager login an admin switched off (a removed monitor) is signed out at once,
	// not when its 7-day session runs out.
	if (auth?.role === 'plant-manager') {
		const manager = await queryOne<{ disabled: boolean }>(
			'SELECT disabled_at IS NOT NULL AS disabled FROM plant_managers WHERE id = $1',
			[auth.id]
		);
		if (!manager || manager.disabled) {
			event.cookies.delete(isHttps ? 'session' : 'session_http', {
				path: COOKIE_PATH,
				secure: isHttps
			});
			auth = null;
		}
	}
	event.locals.user = auth;

	// With BASE_PATH set, URLs arrive prefixed (/pump-attendance/admin). Guard on the path inside
	// the app, otherwise every startsWith('/admin') check below would silently never match.
	const pathname = event.url.pathname;
	const path =
		base && (pathname === base || pathname.startsWith(`${base}/`))
			? pathname.slice(base.length) || '/'
			: pathname;
	if (
		auth?.mustChangePassword &&
		path !== '/change-password' &&
		path !== '/api/auth/password' &&
		path !== '/api/auth/logout'
	) {
		if (path.startsWith('/api/')) {
			return new Response(JSON.stringify({ error: 'Password change required' }), {
				status: 403,
				headers: { 'content-type': 'application/json' }
			});
		}
		return new Response(null, {
			status: 302,
			headers: { location: resolvePath('/change-password') }
		});
	}
	const guardedPrefix = (['/admin', '/vendor', '/plant-manager', '/pump'] as const).find((p) =>
		path.startsWith(p)
	);

	if (guardedPrefix) {
		const requiredRole = guardedPrefix.slice(1) as 'admin' | 'vendor' | 'plant-manager' | 'pump';
		if (!auth) {
			// Remember the page (e.g. an approval link from an email) to return to after login.
			const next =
				event.request.method === 'GET'
					? `?next=${encodeURIComponent(path + event.url.search)}`
					: '';
			return new Response(null, {
				status: 302,
				headers: { location: resolvePath('/login') + next }
			});
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
	// Faces load on click from the session log; the face route checks the pump itself, so
	// vendors may read it too.
	const managerReadOnlyAttendance =
		event.request.method === 'GET' &&
		((auth?.role === 'plant-manager' &&
			/^\/api\/attendance\/(photo|status|backup|face)\//.test(path)) ||
			(auth?.role === 'vendor' && /^\/api\/attendance\/face\//.test(path)));
	if (
		path.startsWith('/api/attendance') &&
		path !== '/api/auth/login' &&
		auth?.role !== 'pump' &&
		auth?.role !== 'admin' &&
		!managerReadOnlyAttendance
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
