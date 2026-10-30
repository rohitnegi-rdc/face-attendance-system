import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { queryOne } from '$lib/server/db';
import { dailyPercent, groupsToday, pumpsToday, readRange } from '$lib/server/attendanceRollup';
import { todayIST } from '$lib/server/time';

// One plant: today's totals, every pump with its shift today and attendance over the range, and
// the pump-by-day calendar.
export const load: PageServerLoad = async ({ params, url }) => {
	if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw error(404, 'plant not found');
	const plant = await queryOne<{
		id: string;
		name: string;
		manager_name: string | null;
		manager_email: string | null;
		area_id: string;
		area_name: string;
	}>(
		`SELECT pl.id, pl.name, pl.manager_name, pl.manager_email, a.id AS area_id, a.name AS area_name
		 FROM plants pl JOIN areas a ON a.id = pl.area_id WHERE pl.id = $1`,
		[params.id]
	);
	if (!plant) throw error(404, 'plant not found');
	const today = todayIST();
	const range = readRange(url, today);
	const [summary, pumps] = await Promise.all([
		groupsToday('plant', today, { plantId: plant.id }),
		pumpsToday({ plantId: plant.id }, today, range.from, range.to)
	]);
	return {
		plant,
		today,
		summary: summary[0] ?? null,
		pumps,
		range,
		daily: await dailyPercent(
			'pump',
			pumps.map((pump) => pump.id),
			range.from,
			range.to
		)
	};
};
