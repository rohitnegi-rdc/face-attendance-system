import type { PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { PUMP_GPS_MAX_AGE_MINUTES } from '$lib/server/locationCheck';
import { isUuid } from '$lib/server/pumpLinks';
import { GPS_STATES, listPumpGps, type PumpGpsRow } from '$lib/server/pumpGps';
import type { GpsState } from '$lib/gpsAge';

type PlantGroup = { id: string; name: string; pumps: PumpGpsRow[] };
type AreaGroup = {
	id: string;
	name: string;
	locationCheck: boolean;
	counts: Record<GpsState, number>;
	plants: PlantGroup[];
};

// Pump GPS: every pump's latest position, listed by Area and plant, problems first. The page
// reloads this every minute while it is open (the worker copies the feed every 5 minutes).
export const load: PageServerLoad = async ({ url }) => {
	const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
	const requestedArea = url.searchParams.get('area') ?? '';
	const areaId = isUuid(requestedArea) ? requestedArea : '';
	const requestedState = url.searchParams.get('gps') ?? '';
	const state = (GPS_STATES as string[]).includes(requestedState)
		? (requestedState as GpsState)
		: '';
	const [areaOptions, rows, [{ now }]] = await Promise.all([
		query<{ id: string; name: string }>('SELECT id, name FROM areas ORDER BY name'),
		listPumpGps(q, areaId),
		query<{ now: string }>(
			`SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata', 'FMHH12:MI:SS am') AS now`
		)
	]);
	// Totals for the chips are before the GPS filter, so each chip says how many it would show.
	const counts: Record<GpsState, number> = { none: 0, old: 0, fresh: 0 };
	for (const row of rows) counts[row.state]++;

	const areas: AreaGroup[] = [];
	for (const row of rows) {
		if (state && row.state !== state) continue;
		let area = areas.at(-1);
		if (area?.id !== row.area_id) {
			area = {
				id: row.area_id,
				name: row.area_name,
				locationCheck: row.location_check,
				counts: { none: 0, old: 0, fresh: 0 },
				plants: []
			};
			areas.push(area);
		}
		area.counts[row.state]++;
		let plant = area.plants.at(-1);
		if (plant?.id !== row.plant_id) {
			plant = { id: row.plant_id, name: row.plant_name, pumps: [] };
			area.plants.push(plant);
		}
		plant.pumps.push(row);
	}
	return {
		q,
		areaId,
		state,
		areaOptions,
		counts,
		areas,
		updatedAt: now,
		maxAgeMinutes: PUMP_GPS_MAX_AGE_MINUTES
	};
};
