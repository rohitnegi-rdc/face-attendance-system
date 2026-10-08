import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { resolve } from '$app/paths';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, resolve('/login'));
	if (!locals.user.mustChangePassword) throw redirect(303, resolve(`/${locals.user.role}`));
	return { email: locals.user.email };
};
