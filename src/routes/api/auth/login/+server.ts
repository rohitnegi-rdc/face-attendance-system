import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { COOKIE_PATH } from '$lib/server/cookies';
import { findAccountByEmail, checkPassword, signToken } from '$lib/server/auth';
import { logger } from '$lib/server/log';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const { email, password } = await request.json();
	if (!email || !password) {
		return json({ error: 'email and password required' }, { status: 400 });
	}

	const account = await findAccountByEmail(email);
	if (!account || !account.password_hash || !(await checkPassword(password, account.password_hash))) {
		logger.warn({ email }, 'login failed');
		return json({ error: 'Invalid credentials' }, { status: 401 });
	}
	if (account.role === 'pump' && account.status === 'disabled') {
		logger.warn({ email }, 'login rejected: pump disabled');
		return json({ error: 'Account disabled. Contact your Plant Manager.' }, { status: 403 });
	}

	const mustChangePassword = account.must_change_password;
	const token = signToken({
		role: account.role,
		id: account.id,
		email: account.email,
		...(mustChangePassword ? { mustChangePassword: true } : {})
	}, mustChangePassword ? '15m' : '7d');
	const isHttps = request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
	cookies.set(isHttps ? 'session' : 'session_http', token, {
		path: COOKIE_PATH,
		httpOnly: true,
		sameSite: 'lax',
		// LAN HTTP is used only for local device testing; deployed HTTPS sessions stay secure.
		secure: isHttps,
		maxAge: mustChangePassword ? 15 * 60 : 60 * 60 * 24 * 7
	});

	logger.info({ email, role: account.role }, 'login success');
	return json({ role: account.role, id: account.id, email: account.email, mustChangePassword });
};
