import { OAuth2Client } from 'google-auth-library';

export function googleOAuthConfig() {
	const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
	const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
	const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
	if (!clientId || !clientSecret || !redirectUri) return null;
	try {
		const parsed = new URL(redirectUri);
		if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') return null;
	} catch {
		return null;
	}
	return { clientId, clientSecret, redirectUri };
}

export function createGoogleOAuthClient(config = googleOAuthConfig()) {
	if (!config) return null;
	return new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
}

export function isRdcGoogleIdentity(
	payload: {
		email?: string;
		email_verified?: boolean;
		hd?: string;
		nonce?: string;
	},
	expectedNonce: string
): boolean {
	const email = payload.email?.trim().toLowerCase() ?? '';
	return (
		payload.email_verified === true &&
		payload.hd?.toLowerCase() === 'rdc.in' &&
		email.endsWith('@rdc.in') &&
		payload.nonce === expectedNonce
	);
}
