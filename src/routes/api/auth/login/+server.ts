import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { SESSION_SECONDS, setSessionCookie } from '$lib/server/cookies';
import { findAccountByEmail, checkPassword, signToken } from '$lib/server/auth';
import { logger } from '$lib/server/log';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const { email, password } = await request.json();
	if (!email || !password) {
		return json({ error: 'email and password required' }, { status: 400 });
	}

	const account = await findAccountByEmail(email);
	if (
		!account ||
		!account.password_hash ||
		!(await checkPassword(password, account.password_hash))
	) {
		logger.warn({ email }, 'login failed');
		return json({ error: 'Invalid credentials' }, { status: 401 });
	}
	if (account.status === 'disabled') {
		logger.warn({ email, role: account.role }, 'login rejected: account disabled');
		return json(
			{
				error:
					account.role === 'pump'
						? 'Account disabled. Contact your Plant Manager.'
						: 'Account disabled. Contact the administrator.'
			},
			{ status: 403 }
		);
	}

	const mustChangePassword = account.must_change_password;
	const token = signToken(
		{
			role: account.role,
			id: account.id,
			email: account.email,
			...(mustChangePassword ? { mustChangePassword: true } : {})
		},
		mustChangePassword ? '15m' : '7d'
	);
	setSessionCookie(cookies, request, token, mustChangePassword ? 15 * 60 : SESSION_SECONDS);

	logger.info({ email, role: account.role }, 'login success');
	return json({ role: account.role, id: account.id, email: account.email, mustChangePassword });
};
