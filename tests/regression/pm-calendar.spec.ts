// UI-15: the plant manager's Attendance page has the person-by-day calendar of the admin pump
// page, with the same rows and letters for the same pump, only for the manager's own pumps.
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
	createAdmin,
	createArea,
	createPlantManager,
	createPump,
	login,
	recordSession
} from './helpers';

async function html(context: APIRequestContext, path: string) {
	const response = await context.get(path);
	expect(response.status(), path).toBe(200);
	return response.text();
}

// Every calendar row as "label: letters, newest day first".
function calendarRows(page: string) {
	const rows: string[] = [];
	for (const row of page.matchAll(
		/<th class="entity-col[^"]*" scope="row" title="([^"]*)"[^>]*>[\s\S]*?<\/th>([\s\S]*?)<\/tr>/g
	)) {
		const letters = [...row[2].matchAll(/>([PME-])<\/td>/g)].map((cell) => cell[1]).join('');
		rows.push(`${row[1]}: ${letters}`);
	}
	return rows;
}

test('UI-15 the plant manager sees the person calendar with the same values as the admin pump page', async () => {
	const { plantId } = await createArea();
	const pumpA = await createPump(plantId);
	const pumpB = await createPump(plantId);
	const { plantId: otherPlant } = await createArea();
	const foreign = await createPump(otherPlant);

	await recordSession(await login(pumpA.email), ['UI15-A1', 'UI15-A2']);
	await recordSession(await login(pumpB.email), ['UI15-B1']);
	await recordSession(await login(foreign.email), ['UI15-F1']);

	const manager = await login((await createPlantManager(plantId)).email);
	const all = (await html(manager, '/plant-manager/attendance')).split(
		'data-testid="pm-person-calendar"'
	)[1];
	const rows = calendarRows(all);
	// Both own pumps' people (the operator photo is one of the group faces), none of the other
	// plant's; today is a shift start.
	expect(rows.filter((r) => r.includes(pumpA.code))).toHaveLength(2);
	expect(rows.filter((r) => r.includes(pumpB.code))).toHaveLength(1);
	expect(rows.some((r) => r.includes(foreign.code))).toBe(false);
	for (const row of rows) expect(row).toMatch(/: M-{29}$/);

	// One pump: exactly the admin pump page's rows and letters.
	const onePump = calendarRows(
		(await html(manager, `/plant-manager/attendance?pump=${pumpA.id}`)).split(
			'data-testid="pm-person-calendar"'
		)[1]
	);
	const admin = await login((await createAdmin()).email);
	expect(onePump).toEqual(calendarRows(await html(admin, `/admin/pumps/${pumpA.id}`)));

	// Another plant's pump in the filter is ignored: the manager's own pumps, nothing else.
	const forced = calendarRows(
		(await html(manager, `/plant-manager/attendance?pump=${foreign.id}`)).split(
			'data-testid="pm-person-calendar"'
		)[1]
	);
	expect(forced).toEqual(rows);
});
