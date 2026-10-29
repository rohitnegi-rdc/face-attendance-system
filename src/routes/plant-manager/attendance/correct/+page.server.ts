import type { PageServerLoad } from './$types';
import { resolve } from '$app/paths';
import { fixAttendanceActions, loadFixAttendance } from '$lib/server/fixAttendance';

// Fix attendance for one pump of the manager's plants and one day; the same page as the admin's
// (fixAttendance.ts), limited to the manager's plants.
export const load: PageServerLoad = async ({ url, locals }) =>
	loadFixAttendance(
		{ role: 'plant-manager', id: locals.user!.id },
		url,
		resolve('/plant-manager/attendance')
	);

export const actions = fixAttendanceActions('plant-manager');
