import type { PageServerLoad } from './$types';
import { groupsToday } from '$lib/server/attendanceRollup';
import { todayIST } from '$lib/server/time';

// Every area with pumps and today's attendance, searchable by area name or the name of one of its
// plants; each opens the area page (plants, pumps, calendars).
export const load: PageServerLoad = async ({ url }) => {
	const today = todayIST();
	const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
	return { today, q, areas: await groupsToday('area', today, { q }) };
};
