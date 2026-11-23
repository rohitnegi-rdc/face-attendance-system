import type { Actions, PageServerLoad } from './$types';
import { decideLink, listGangs } from '$lib/server/gangs';

// Gangs by Area and plant, with the "Same person?" questions (src/lib/server/gangs.ts).
export const load: PageServerLoad = async ({ locals, url }) =>
	listGangs({ role: 'plant-manager', id: locals.user!.id }, url);

export const actions: Actions = {
	link: async ({ request, locals }) =>
		decideLink({ role: 'plant-manager', id: locals.user!.id }, await request.formData())
};
