import type { PageServerLoad } from './$types';
import { googleOAuthConfig } from '$lib/server/googleOAuth';

const oauthErrors: Record<string, string> = {
	cancelled: 'Google sign-in was cancelled.',
	failed: 'Google sign-in could not be completed. Please try again.',
	restricted: 'Use a verified Google Workspace account from rdc.in.',
	unassigned: 'This rdc.in account does not have an assigned application role.',
	unavailable: 'Google sign-in is not configured for this application.'
};

export const load: PageServerLoad = ({ url }) => ({
	googleOAuthEnabled: Boolean(googleOAuthConfig()),
	oauthError: oauthErrors[url.searchParams.get('oauth') ?? ''] ?? ''
});
