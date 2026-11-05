import { base } from '$app/paths';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import {
	createPumpLink,
	isUuid,
	linkToken,
	listPumpLinks,
	revokePumpLink,
	type PumpLinkRow
} from '$lib/server/pumpLinks';

type PumpLine = Omit<PumpLinkRow, 'link_id'> & { link: string | null };
type PlantGroup = { id: string; name: string; pumps: PumpLine[] };
type AreaGroup = { id: string; name: string; pumps: number; linked: number; plants: PlantGroup[] };

export const load: PageServerLoad = async ({ url }) => {
	const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
	const requestedArea = url.searchParams.get('area') ?? '';
	const areaId = isUuid(requestedArea) ? requestedArea : '';
	const [areaOptions, rows] = await Promise.all([
		query<{ id: string; name: string }>('SELECT id, name FROM areas ORDER BY name'),
		listPumpLinks(q, areaId)
	]);
	const areas: AreaGroup[] = [];
	for (const { link_id, ...row } of rows) {
		let area = areas.at(-1);
		if (area?.id !== row.area_id) {
			area = { id: row.area_id, name: row.area_name, pumps: 0, linked: 0, plants: [] };
			areas.push(area);
		}
		let plant = area.plants.at(-1);
		if (plant?.id !== row.plant_id) {
			plant = { id: row.plant_id, name: row.plant_name, pumps: [] };
			area.plants.push(plant);
		}
		area.pumps++;
		if (link_id) area.linked++;
		plant.pumps.push({
			...row,
			link: link_id ? `${url.origin}${base}/link/${linkToken(link_id)}` : null
		});
	}
	return { q, areaId, areaOptions, areas };
};

async function pumpIdFrom(request: Request) {
	const id = String((await request.formData()).get('pump') ?? '');
	return isUuid(id) ? id : null;
}

export const actions: Actions = {
	generate: async ({ request, locals }) => {
		const pumpId = await pumpIdFrom(request);
		if (!pumpId) return fail(400, { message: 'Pump not found.' });
		await createPumpLink(pumpId, locals.user!.id);
		return { success: true };
	},
	revoke: async ({ request, locals }) => {
		const pumpId = await pumpIdFrom(request);
		if (!pumpId) return fail(400, { message: 'Pump not found.' });
		await revokePumpLink(pumpId, locals.user!.id);
		return { success: true };
	}
};
