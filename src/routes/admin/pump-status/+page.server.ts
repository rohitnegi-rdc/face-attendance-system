import type { Actions, PageServerLoad } from './$types';
import { loadPumpStatus, setPumpDayStatus } from '$lib/server/pumpStatus';

// Pump status (src/lib/server/pumpStatus.ts): today and tomorrow editable, days per status over a period.
export const load: PageServerLoad = async ({ locals, url }) => loadPumpStatus(locals.user!, url);

export const actions: Actions = { setStatus: setPumpDayStatus };
