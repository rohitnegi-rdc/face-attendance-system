import type { PageServerLoad } from './$types';
import { resolve } from '$app/paths';
import { fixAttendanceActions, loadFixAttendance } from '$lib/server/fixAttendance';

// Fix attendance for one pump and day; the same page as the plant manager's (fixAttendance.ts).
export const load: PageServerLoad = async ({ url, locals }) =>
	loadFixAttendance({ role: 'admin', id: locals.user!.id }, url, resolve('/admin/attendance'));

export const actions = fixAttendanceActions('admin');
