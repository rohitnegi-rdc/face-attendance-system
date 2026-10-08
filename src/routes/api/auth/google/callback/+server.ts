import { timingSafeEqual } from 'node:crypto';
import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import type { RequestHandler } from './$types';
import { COOKIE_PATH } from '$lib/server/cookies';
import { findAccountByEmail, signToken } from '$lib/server/auth';
import { logger } from '$lib/server/log';
import {
	createGoogleOAuthClient,
	googleOAuthConfig,
	isRdcGoogleIdentity
} from '$lib/server/googleOAuth';

function sameSecret(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

function loginFailure(reason: string): never {
	throw redirect(303, resolve(`/login?oauth=${encodeURIComponent(reason)}`));
}

export const GET: RequestHandler = async ({ url, cookies, request }) => {
	const config = googleOAuthConfig();
	const client = createGoogleOAuthClient(config);
	const stateCookie = cookies.get('google_oauth_state');
	const nonceCookie = cookies.get('google_oauth_nonce');
	const verifierCookie = cookies.get('google_oauth_verifier');
	const secure = config ? new URL(config.redirectUri).protocol === 'https:' : false;
	cookies.delete('google_oauth_state', { path: COOKIE_PATH, secure });
	cookies.delete('google_oauth_nonce', { path: COOKIE_PATH, secure });
	cookies.delete('google_oauth_verifier', { path: COOKIE_PATH, secure });

	if (!config || !client) loginFailure('unavailable');
	if (url.searchParams.has('error')) loginFailure('cancelled');
	const state = url.searchParams.get('state');
	const code = url.searchParams.get('code');
	if (
		!state ||
		!stateCookie ||
		!sameSecret(state, stateCookie) ||
		!nonceCookie ||
		!verifierCookie ||
		!code
	) {
		loginFailure('failed');
	}

	try {
		const { tokens } = await client.getToken({ code, codeVerifier: verifierCookie });
		if (!tokens.id_token) loginFailure('failed');
		const ticket = await client.verifyIdToken({
			idToken: tokens.id_token,
			audience: config.clientId
		});
		const payload = ticket.getPayload();
		if (!payload || !isRdcGoogleIdentity(payload, nonceCookie)) loginFailure('restricted');

		const email = payload.email!.trim().toLowerCase();
		const account = await findAccountByEmail(email);
		if (!account || (account.role === 'pump' && account.status === 'disabled')) {
			loginFailure('unassigned');
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
			secure: isHttps,
			maxAge: mustChangePassword ? 15 * 60 : 60 * 60 * 24 * 7
		});
		logger.info({ email, role: account.role }, 'Google OAuth login success');
		throw redirect(303, resolve(mustChangePassword ? '/change-password' : `/${account.role}`));
	} catch (error) {
		if (error && typeof error === 'object' && 'status' in error && 'location' in error) throw error;
		logger.warn({ error: String(error) }, 'Google OAuth callback failed');
		loginFailure('failed');
	}
};
