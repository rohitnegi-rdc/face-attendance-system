import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { findAccountByEmail, checkPassword, signToken } from '$lib/server/auth';
import { logger } from '$lib/server/log';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const { email, password } = await request.json();
	if (!email || !password) {
		return json({ error: 'email and password required' }, { status: 400 });
	}

	const account = await findAccountByEmail(email);
	if (!account || !(await checkPassword(password, account.password_hash))) {
		logger.warn({ email }, 'login failed');
		return json({ error: 'Invalid credentials' }, { status: 401 });
	}

	const token = signToken({ role: account.role, id: account.id, email: account.email });
	cookies.set('session', token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 60 * 60 * 24 * 7
	});

	logger.info({ email, role: account.role }, 'login success');
	return json({ role: account.role, id: account.id, email: account.email });
};
