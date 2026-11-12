import type { Actions, PageServerLoad } from './$types';
import { base } from '$app/paths';
import {
	cancelAction,
	decideAction,
	loadMissedDaysPage,
	requestAction
} from '$lib/server/regularisationPage';

// Missed days (regularisation) for a plant-manager login. As business manager it approves or
// rejects the requests of its plants; as plant manager it asks for a missed day of its own plants
// for the operator (broken or lost phone, operator away) and sees what it sent.
export const load: PageServerLoad = async ({ locals, url }) =>
	loadMissedDaysPage({ role: 'plant-manager', id: locals.user!.id }, url);

export const actions: Actions = {
	request: ({ locals, request, url }) =>
		requestAction({ role: 'plant-manager', id: locals.user!.id }, request, url.origin + base),
	decide: ({ locals, request }) =>
		decideAction({ role: 'business_manager', id: locals.user!.id }, request),
	cancel: ({ locals, request }) =>
		cancelAction({ role: 'plant-manager', id: locals.user!.id }, request)
};
