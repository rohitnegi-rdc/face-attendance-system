import { base } from '$app/paths';
import type { Cookies } from '@sveltejs/kit';

// Cookies are scoped to the app's base path (BASE_PATH, see vite.config.ts) so other apps on the
// same domain, e.g. ops.rdcc.ai/opsmitra, never receive or overwrite them. "/" when served at root.
// Kept out of auth.ts because scripts/seed.ts imports that outside SvelteKit.
export const COOKIE_PATH = base || '/';

export const SESSION_SECONDS = 60 * 60 * 24 * 7;
// The longest a browser keeps a cookie (Chrome: 400 days). A pump link's session renews it on every
// page opened, so it never runs out while the phone is in use.
export const LINK_SESSION_SECONDS = 60 * 60 * 24 * 400;

export function setSessionCookie(
	cookies: Cookies,
	request: Request,
	token: string,
	maxAge: number
) {
	const isHttps = request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
	cookies.set(isHttps ? 'session' : 'session_http', token, {
		path: COOKIE_PATH,
		httpOnly: true,
		sameSite: 'lax',
		// LAN HTTP is used only for local device testing; deployed HTTPS sessions stay secure.
		secure: isHttps,
		maxAge
	});
}
