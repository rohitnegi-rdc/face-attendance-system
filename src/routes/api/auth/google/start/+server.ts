import { randomBytes } from 'node:crypto';
import { redirect } from '@sveltejs/kit';
import { CodeChallengeMethod } from 'google-auth-library';
import type { RequestHandler } from './$types';
import { createGoogleOAuthClient, googleOAuthConfig } from '$lib/server/googleOAuth';

export const GET: RequestHandler = async ({ cookies }) => {
	const config = googleOAuthConfig();
	const client = createGoogleOAuthClient(config);
	if (!config || !client) {
		return new Response('Google sign-in is not configured.', { status: 503 });
	}

	const state = randomBytes(32).toString('base64url');
	const nonce = randomBytes(32).toString('base64url');
	const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
	const secure = new URL(config.redirectUri).protocol === 'https:';
	const cookieOptions = {
		path: '/',
		httpOnly: true,
		sameSite: 'lax' as const,
		secure,
		maxAge: 600
	};
	cookies.set('google_oauth_state', state, cookieOptions);
	cookies.set('google_oauth_nonce', nonce, cookieOptions);
	cookies.set('google_oauth_verifier', codeVerifier, cookieOptions);

	const url = client.generateAuthUrl({
		access_type: 'online',
		prompt: 'select_account',
		response_type: 'code',
		scope: ['openid', 'email', 'profile'],
		hd: 'rdc.in',
		state,
		nonce,
		code_challenge: codeChallenge,
		code_challenge_method: CodeChallengeMethod.S256
	});
	throw redirect(302, url);
};
