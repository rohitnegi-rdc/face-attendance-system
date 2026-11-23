import type { Actions, PageServerLoad } from './$types';
import { cancelAction, decideAction, loadMissedDaysPage } from '$lib/server/regularisationPage';

// Missed days (regularisation) for a plant-manager login: it approves or rejects the requests of the
// plants it decides for (business manager, or plant manager of a plant with no business manager;
// view missed_day_deciders) and sees the rest of its plants. It does not apply: since 2026-11-18 the
// operator applies on the pump screen. Cancel stays for requests it sent before.
export const load: PageServerLoad = async ({ locals, url }) =>
	loadMissedDaysPage({ role: 'plant-manager', id: locals.user!.id }, url);

export const actions: Actions = {
	decide: ({ locals, request }) => decideAction({ role: 'manager', id: locals.user!.id }, request),
	cancel: ({ locals, request }) =>
		cancelAction({ role: 'plant-manager', id: locals.user!.id }, request)
};
