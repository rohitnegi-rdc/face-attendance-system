import type { PageServerLoad } from './$types';
import { queryOne } from '$lib/server/db';
import { error } from '@sveltejs/kit';
import { dailyPercent, groupsToday, pumpsToday, readRange } from '$lib/server/attendanceRollup';
import { todayIST } from '$lib/server/time';

// One area: today per plant, every pump with its shift today and attendance over the range, and
// the plant-by-day and pump-by-day calendars.
export const load: PageServerLoad = async ({ params, url }) => {
	if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw error(404, 'area not found');
	const area = await queryOne<{ id: string; name: string }>(
		`SELECT id, name FROM areas WHERE id = $1`,
		[params.id]
	);
	if (!area) throw error(404, 'area not found');
	const today = todayIST();
	const range = readRange(url, today);
	const [plants, pumps] = await Promise.all([
		groupsToday('plant', today, { areaId: area.id }),
		pumpsToday({ areaId: area.id }, today, range.from, range.to)
	]);
	const [plantDaily, pumpDaily] = await Promise.all([
		dailyPercent(
			'plant',
			plants.map((plant) => plant.id),
			range.from,
			range.to
		),
		dailyPercent(
			'pump',
			pumps.map((pump) => pump.id),
			range.from,
			range.to
		)
	]);
	return { area, today, plants, pumps, range, plantDaily, pumpDaily };
};
