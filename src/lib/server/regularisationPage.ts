// Load and form actions shared by the admin and plant-manager Missed days pages
// (src/routes/admin/regularisations, src/routes/plant-manager/regularisations).
import { fail } from '@sveltejs/kit';
import { isDateKey } from '$lib/date';
import {
	cancelRequest,
	createRequest,
	crewFor,
	decide,
	listRequestablePumps,
	listRequests,
	undoRequest,
	type Decider,
	type Requester
} from './regularisation';
import { pumpMonth } from './regularisationDays';
import { todayIST } from './time';

// ?pump=&month=&day= choose what the calendar shows. A pump outside the login's scope is ignored;
// with none chosen the pump with the latest missed day opens, on the month of that day.
export async function loadMissedDaysPage(viewer: Requester, url: URL) {
	const [requests, pumps] = await Promise.all([
		listRequests(viewer, { limit: 300 }),
		listRequestablePumps(viewer)
	]);
	const pump = pumps.find((p) => p.id === url.searchParams.get('pump')) ?? pumps[0] ?? null;
	const day = url.searchParams.get('day') ?? '';
	const asked = url.searchParams.get('month') ?? (isDateKey(day) ? day.slice(0, 7) : null);
	const fallback = (pump?.latestMissed ?? todayIST()).slice(0, 7);
	const calendar = pump
		? ((asked ? await pumpMonth(pump.id, asked) : null) ?? (await pumpMonth(pump.id, fallback)))
		: null;
	const selected = calendar?.days.find((d) => d.day === day) ?? null;
	const crew =
		pump && selected?.canApply && selected.kind
			? await crewFor(pump.id, selected.day, selected.kind)
			: null;
	return { requests, pumps, pump, calendar, selected, crew };
}

export async function requestAction(actor: Requester, request: Request, linkBase: string) {
	const form = await request.formData();
	const pumpId = String(form.get('pump_id') || '');
	const day = String(form.get('day') || '');
	if (!isDateKey(day)) return fail(400, { formKind: 'request', message: 'Choose a day.' });
	const result = await createRequest(
		actor,
		{
			pumpId,
			day,
			reason: String(form.get('reason') || ''),
			note: String(form.get('note') || ''),
			workers: form.getAll('workers').map(String)
		},
		linkBase
	);
	if (!result.ok) return fail(result.status, { formKind: 'request', message: result.error });
	return {
		formKind: 'request',
		success: true,
		message:
			result.status === 'approved'
				? 'Regularised. The day now counts.'
				: 'Sent for approval. The business manager has been emailed.'
	};
}

export async function decideAction(decider: Decider, request: Request) {
	const form = await request.formData();
	const id = String(form.get('id') || '');
	const approve = form.get('decision') === 'approve';
	const result = await decide(decider, id, {
		approve,
		rejectReason: String(form.get('reject_reason') || ''),
		note: String(form.get('note') || '')
	});
	if (!result.ok) return fail(result.status, { formKind: 'row', id, message: result.error });
	return {
		formKind: 'row',
		id,
		success: true,
		message: approve ? 'Approved. The day now counts.' : 'Rejected.'
	};
}

export async function cancelAction(actor: Requester, request: Request) {
	const id = String((await request.formData()).get('id') || '');
	const result = await cancelRequest(actor, id);
	if (!result.ok) return fail(result.status, { formKind: 'row', id, message: result.error });
	return { formKind: 'row', id, success: true, message: 'Request withdrawn.' };
}

export async function undoAction(adminId: string, request: Request) {
	const form = await request.formData();
	const id = String(form.get('id') || '');
	const result = await undoRequest(adminId, id, String(form.get('reason') || ''));
	if (!result.ok) return fail(result.status, { formKind: 'row', id, message: result.error });
	return { formKind: 'row', id, success: true, message: 'Undone. The day no longer counts.' };
}
