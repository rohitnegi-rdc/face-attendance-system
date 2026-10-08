import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { COOKIE_PATH } from '$lib/server/cookies';
import { hashPassword, signToken } from '$lib/server/auth';
import { pool } from '$lib/server/db';

const accountTables = {
	admin: 'admins',
	vendor: 'vendors',
	'plant-manager': 'plant_managers',
	pump: 'pumps'
} as const;

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	const user = locals.user;
	if (!user?.mustChangePassword) return json({ error: 'Password change is not required.' }, { status: 403 });

	const body = await request.json().catch(() => null);
	const password = typeof body?.password === 'string' ? body.password : '';
	const confirmation = typeof body?.confirmation === 'string' ? body.confirmation : '';
	if (password.length < 12 || password.length > 128) {
		return json({ error: 'Choose a password between 12 and 128 characters.' }, { status: 400 });
	}
	if (password !== confirmation) return json({ error: 'The passwords do not match.' }, { status: 400 });

	const table = accountTables[user.role];
	const passwordHash = await hashPassword(password);
	const result = await pool.query(
		`UPDATE ${table} SET password_hash = $1, must_change_password = FALSE WHERE id = $2`,
		[passwordHash, user.id]
	);
	if (!result.rowCount) return json({ error: 'Account no longer exists.' }, { status: 404 });

	const secure = request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
	const cookieName = secure ? 'session' : 'session_http';
	cookies.delete(secure ? 'session_http' : 'session', { path: COOKIE_PATH, secure: !secure });
	cookies.set(cookieName, signToken({ role: user.role, id: user.id, email: user.email }), {
		path: COOKIE_PATH,
		httpOnly: true,
		sameSite: 'lax',
		secure,
		maxAge: 60 * 60 * 24 * 7
	});
	return json({ ok: true, role: user.role });
};
