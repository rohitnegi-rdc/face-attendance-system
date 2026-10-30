import type { PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { groupsToday } from '$lib/server/attendanceRollup';
import { todayIST } from '$lib/server/time';

// Every plant with pumps and today's attendance, grouped by area, searchable by plant or area name
// and filtered to one area. Each opens the plant page (pumps, calendar).
export const load: PageServerLoad = async ({ url }) => {
	const today = todayIST();
	const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
	const areaParam = url.searchParams.get('area') ?? '';
	const areaId = /^[0-9a-f-]{36}$/i.test(areaParam) ? areaParam : '';
	const [plants, areas] = await Promise.all([
		groupsToday('plant', today, { q, areaId: areaId || undefined }),
		query<{ id: string; name: string }>(
			`SELECT a.id, a.name FROM areas a
			 WHERE EXISTS (SELECT 1 FROM plants pl JOIN pumps pu ON pu.plant_id = pl.id WHERE pl.area_id = a.id)
			 ORDER BY a.name`
		)
	]);
	return { today, q, areaId, areas, plants };
};
