import type { Actions, PageServerLoad } from './$types';
import { loadGang, moveShiftGang } from '$lib/server/gangs';

// One gang: members, day by day, and moving a shift counted for the wrong gang.
export const load: PageServerLoad = async ({ locals, params, url }) =>
	loadGang({ role: 'admin', id: locals.user!.id }, params.id, url);

export const actions: Actions = {
	move: async ({ request, locals }) =>
		moveShiftGang({ role: 'admin', id: locals.user!.id }, await request.formData())
};
