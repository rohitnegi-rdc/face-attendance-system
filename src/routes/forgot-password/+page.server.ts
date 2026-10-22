import { fail } from '@sveltejs/kit';
import type { Actions } from './$types';
import { RESET_LINK_MINUTES, requestPasswordReset } from '$lib/server/passwordReset';

export const actions: Actions = {
	default: async ({ request, url }) => {
		const email = String((await request.formData()).get('email') ?? '').trim();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
			return fail(400, { email, error: 'Enter the email address you sign in with.' });
		}
		const result = await requestPasswordReset(email, url);
		return { email, result, minutes: RESET_LINK_MINUTES };
	}
};
