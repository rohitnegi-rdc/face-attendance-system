import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { resolve } from '$app/paths';
import { findResetToken, passwordProblem, resetPasswordWithToken } from '$lib/server/passwordReset';

export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token') ?? '';
	const account = await findResetToken(token);
	return { token, email: account?.email ?? null };
};

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const token = String(form.get('token') ?? '');
		const password = String(form.get('password') ?? '');
		const problem = passwordProblem(password, String(form.get('confirmation') ?? ''));
		if (problem) return fail(400, { error: problem });
		if (!(await resetPasswordWithToken(token, password))) return fail(410, { expired: true });
		redirect(303, `${resolve('/login')}?reset=done`);
	}
};
