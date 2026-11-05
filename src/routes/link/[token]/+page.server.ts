import { resolve } from '$app/paths';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { signLinkSession } from '$lib/server/auth';
import { LINK_SESSION_SECONDS, setSessionCookie } from '$lib/server/cookies';
import { logger } from '$lib/server/log';
import { pumpFromLink } from '$lib/server/pumpLinks';

// A pump's direct sign-in link (admin page: /admin/pump-links). A working link signs the pump in
// and opens its screen; anything else explains itself, because the person holding the phone cannot
// fix it alone. An admin or manager who opens a link keeps their own session.
export const load: PageServerLoad = async ({ params, cookies, request, locals }) => {
	if (locals.user && locals.user.role !== 'pump') {
		return { problem: 'signed_in' as const };
	}
	const pump = await pumpFromLink(params.token);
	if (!pump) {
		logger.warn({}, 'pump link refused: changed, unknown or revoked');
		return { problem: 'not_working' as const };
	}
	if (pump.status === 'disabled') {
		logger.warn({ pumpId: pump.id }, 'pump link refused: account disabled');
		return { problem: 'disabled' as const };
	}
	const token = signLinkSession({
		role: 'pump',
		id: pump.id,
		email: pump.email,
		linkId: pump.link_id
	});
	setSessionCookie(cookies, request, token, LINK_SESSION_SECONDS);
	logger.info({ pumpId: pump.id, linkId: pump.link_id }, 'pump signed in with link');
	redirect(303, resolve('/pump'));
};
