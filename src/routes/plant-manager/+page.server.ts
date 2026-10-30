import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { addDaysStr, isDateKey } from '$lib/date';
import { clearPumpCheck, dayChecklist, savePumpCheck } from '$lib/server/pumpChecks';
import { nowIST, todayIST } from '$lib/server/time';

// The day's checklist of a plant manager or monitor: every pump of their plants or Areas, the
// ones that need a look first, each with Fix attendance and Checked. ?day= picks an earlier day.
export const load: PageServerLoad = async ({ locals, url }) => {
	const today = todayIST();
	const asked = url.searchParams.get('day') ?? '';
	const day = isDateKey(asked) && asked <= today ? asked : today;
	const late = day < today || nowIST().hour() >= 20;
	const pumps = await dayChecklist(locals.user!.id, day, late);
	return { today, yesterday: addDaysStr(today, -1), day, pumps };
};

const UUID = /^[0-9a-f-]{36}$/i;

function readForm(form: FormData) {
	const pumpId = String(form.get('pump_id') || '');
	const day = String(form.get('day') || '');
	return UUID.test(pumpId) && isDateKey(day) && day <= todayIST() ? { pumpId, day } : null;
}

export const actions: Actions = {
	check: async ({ request, locals }) => {
		const form = await request.formData();
		const target = readForm(form);
		const note = String(form.get('note') || '')
			.trim()
			.slice(0, 500);
		if (!target || !(await savePumpCheck(locals.user!.id, target.pumpId, target.day, note)))
			return fail(404, { pumpId: target?.pumpId, error: 'Pump not found.' });
		return { pumpId: target.pumpId, message: 'Checked.' };
	},
	uncheck: async ({ request, locals }) => {
		const target = readForm(await request.formData());
		if (!target) return fail(404, { error: 'Pump not found.' });
		await clearPumpCheck(locals.user!.id, target.pumpId, target.day);
		return { pumpId: target.pumpId, message: 'Check removed.' };
	}
};
