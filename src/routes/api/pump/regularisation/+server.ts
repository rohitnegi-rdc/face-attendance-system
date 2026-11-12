import { json } from '@sveltejs/kit';
import { base } from '$app/paths';
import type { RequestHandler } from './$types';
import { isDateKey } from '$lib/date';
import { pool } from '$lib/server/db';
import {
	cancelRequest,
	createRequest,
	crewFor,
	pumpRegularisationState
} from '$lib/server/regularisation';
import { dayInfo, pumpMonth } from '$lib/server/regularisationDays';

// The pump screen's calendar (PumpRegularise.svelte): GET lists its missed days and recent requests;
// GET ?month=YYYY-MM gives one month's days; GET ?day= gives who can be selected for a day that can
// be applied for; POST (multipart: day, reason, note, workers, voice) applies for a day; DELETE ?id=
// withdraws a waiting request.
function pumpId(locals: App.Locals) {
	return locals.user?.role === 'pump' ? locals.user.id : null;
}

export const GET: RequestHandler = async ({ locals, url }) => {
	const pump = pumpId(locals);
	if (!pump) return json({ error: 'Forbidden' }, { status: 403 });
	const month = url.searchParams.get('month');
	if (month) {
		const calendar = await pumpMonth(pump, month);
		if (!calendar) return json({ error: 'No such month' }, { status: 400 });
		return json(calendar);
	}
	const day = url.searchParams.get('day');
	if (day) {
		if (!isDateKey(day)) return json({ error: 'Not a day' }, { status: 400 });
		const info = await dayInfo(pool, pump, day);
		if (!info.canApply || !info.kind) {
			return json({ error: 'This day cannot be regularised' }, { status: 409 });
		}
		return json(await crewFor(pump, day, info.kind));
	}
	return json(await pumpRegularisationState(pump));
};

export const POST: RequestHandler = async ({ locals, request, url }) => {
	const pump = pumpId(locals);
	if (!pump) return json({ error: 'Forbidden' }, { status: 403 });
	const form = await request.formData().catch(() => null);
	if (!form) return json({ error: 'Send the form again' }, { status: 400 });
	const voice = form.get('voice');
	const result = await createRequest(
		{ role: 'pump', id: pump },
		{
			pumpId: pump,
			day: String(form.get('day') || ''),
			reason: String(form.get('reason') || ''),
			note: String(form.get('note') || ''),
			workers: form.getAll('workers').map(String),
			voice:
				voice instanceof File && voice.size > 0
					? { bytes: new Uint8Array(await voice.arrayBuffer()), type: voice.type }
					: null
		},
		url.origin + base
	);
	if (!result.ok) return json({ error: result.error }, { status: result.status });
	return json({ id: result.id, status: result.status });
};

export const DELETE: RequestHandler = async ({ locals, url }) => {
	const pump = pumpId(locals);
	if (!pump) return json({ error: 'Forbidden' }, { status: 403 });
	const result = await cancelRequest({ role: 'pump', id: pump }, url.searchParams.get('id') ?? '');
	if (!result.ok) return json({ error: result.error }, { status: result.status });
	return json({ ok: true });
};
