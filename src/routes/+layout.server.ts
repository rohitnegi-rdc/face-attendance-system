import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	return {
		user: locals.user
			? {
					id: locals.user.id,
					role: locals.user.role,
					email: locals.user.email
				}
			: null
	};
};
