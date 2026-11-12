import type { Actions, PageServerLoad } from './$types';
import { base } from '$app/paths';
import {
	cancelAction,
	decideAction,
	loadMissedDaysPage,
	requestAction,
	undoAction
} from '$lib/server/regularisationPage';

// Missed days (regularisation): every request, waiting first, and every missed day of every pump.
// An admin decides any request, undoes an approved one, and regularises a day directly.
export const load: PageServerLoad = async ({ locals, url }) =>
	loadMissedDaysPage({ role: 'admin', id: locals.user!.id }, url);

export const actions: Actions = {
	request: ({ locals, request, url }) =>
		requestAction({ role: 'admin', id: locals.user!.id }, request, url.origin + base),
	decide: ({ locals, request }) => decideAction({ role: 'admin', id: locals.user!.id }, request),
	cancel: ({ locals, request }) => cancelAction({ role: 'admin', id: locals.user!.id }, request),
	undo: ({ locals, request }) => undoAction(locals.user!.id, request)
};
