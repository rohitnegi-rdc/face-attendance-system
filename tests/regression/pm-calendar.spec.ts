// UI-15: the plant manager's Attendance page has the person-by-day calendar of the admin pump
// page, with the same rows and letters for the same pump, only for the manager's own pumps.
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
	createAdmin,
	createArea,
	createPlantManager,
	createPump,
	db,
	login,
	recordSession
} from './helpers';
import { daysAgo, noSidewaysScroll, signIn, todayIST } from './regularisationHelpers';

// The day as the calendar cells name it: "25-11-2026".
const dayLabel = (day: string) => day.split('-').reverse().join('-');

async function html(context: APIRequestContext, path: string) {
	const response = await context.get(path);
	expect(response.status(), path).toBe(200);
	return response.text();
}

// Every calendar row as "label: letters, newest day first".
function calendarRows(html: string) {
	// Svelte's hydration markers (<!---->) are not content.
	const page = html.replace(/<!--[\s\S]*?-->/g, '');
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

// UI-18: a monitor (no plant of its own, its Area given) sees on Attendance, per pump and day, how
// many workers had a full shift, a start only and an end only, with "Shift on" for a start still
// waiting for its end, and the same three added up per pump over the range. Phone width, no
// sideways page scroll.
test('UI-18 a monitor sees full shift, start only and end only per pump and day', async ({
	page
}) => {
	const { areaId, plantId } = await createArea();
	const pump = await createPump(plantId);
	// Today: a shift start of three workers, still waiting for its end.
	await recordSession(await login(pump.email), ['UI18-1', 'UI18-2', 'UI18-3']);
	const people = (
		await db.query<{ id: string }>(
			'SELECT id FROM persons WHERE pump_id = $1 ORDER BY display_seq',
			[pump.id]
		)
	).rows;
	expect(people).toHaveLength(3);
	// Yesterday: two full shifts, one start only; the day before: one end only.
	const yesterday = daysAgo(1);
	const before = daysAgo(2);
	const add = (person: string, day: string, morning: boolean, evening: boolean) =>
		db.query(
			`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched, evening_matched)
			 VALUES ($1, $2, $3, $4, $5)`,
			[person, pump.id, day, morning, evening]
		);
	await add(people[0].id, yesterday, true, true);
	await add(people[1].id, yesterday, true, true);
	await add(people[2].id, yesterday, true, false);
	await add(people[0].id, before, false, true);

	const monitor = await createPlantManager(plantId);
	await db.query('UPDATE plant_managers SET is_monitor = true WHERE id = $1', [monitor.id]);
	await db.query('DELETE FROM plant_manager_assignments WHERE manager_id = $1', [monitor.id]);
	await db.query('INSERT INTO monitor_areas (manager_id, area_id) VALUES ($1, $2)', [
		monitor.id,
		areaId
	]);

	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, monitor.email);
	await page.goto(`/plant-manager/attendance?pump=${pump.id}`);
	const cell = (day: string) =>
		page.getByRole('cell', { name: new RegExp(`^${pump.code}, .*${dayLabel(day)}:`) });
	await expect(cell(todayIST())).toHaveText(/Shift on\s*0 full\s*3 start\s*0 end/);
	await expect(cell(yesterday)).toHaveText(/^2 full\s*1 start\s*0 end$/);
	await expect(cell(before)).toHaveText(/^0 full\s*0 start\s*1 end$/);
	await expect(cell(daysAgo(3))).toHaveText('-');
	// Range totals: 2 full, 4 start only (1 yesterday + 3 today), 1 end only.
	const total = page.getByTestId('pump-total').filter({ hasText: pump.code });
	await expect(total.getByTestId('split-full')).toHaveText('2 full shift');
	await expect(total.getByTestId('split-start')).toHaveText('4 start only');
	await expect(total.getByTestId('split-end')).toHaveText('1 end only');
	await noSidewaysScroll(page);
	await page.getByTestId('pump-totals').scrollIntoViewIfNeeded();
	await page.screenshot({
		path: 'artifacts/pm-split/monitor-attendance-phone.png',
		fullPage: true
	});
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.screenshot({
		path: 'artifacts/pm-split/monitor-attendance-desktop.png',
		fullPage: true
	});
});
