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
	// Plant, then Pump, even with only one plant (UI-20).
	await expect(page.getByTestId('pm-plant-filter')).toBeVisible();
	const cell = (day: string) =>
		page.getByRole('cell', { name: new RegExp(`^${pump.code}, .*${dayLabel(day)}:`) });
	// The full-shift count leads; a missing half shows only when there is one.
	await expect(cell(todayIST())).toHaveText(/^0 full\s*3 start only\s*0 end only\s*Shift on$/);
	await expect(cell(yesterday)).toHaveText(/^2 full\s*1 start only\s*0 end only$/);
	await expect(cell(before)).toHaveText(/^0 full\s*0 start only\s*1 end only$/);
	// Every 0 is red (zero full shifts, a zero start only or end only).
	await expect(cell(before).locator('.sc-zero')).toHaveCount(2);
	await expect(cell(daysAgo(3))).toHaveText('–');
	// Range total under the pump code: 2 full, 4 start only (1 yesterday + 3 today), 1 end only.
	await expect(page.getByTestId('pump-total')).toHaveText(/^2 full\s*·\s*4 start\s*·\s*1 end$/);
	await noSidewaysScroll(page);
	await page.getByRole('heading', { name: 'Daily attendance' }).scrollIntoViewIfNeeded();
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

// UI-19: a back link returns to the page it was opened from, named after it, not to one fixed page
// (2026-11-26); a reload keeps it; opened directly it falls back to the page's usual parent.
test('UI-19 back links return to the previous page', async ({ page, browser }) => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const admin = await createAdmin();
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, admin.email);

	await page.goto(`/admin/pumps?q=${pump.code}`);
	await page.getByRole('link', { name: pump.code, exact: true }).first().click();
	await page.waitForURL(new RegExp(`/admin/pumps/${pump.id}`));
	const back = page.getByTestId('back-link');
	await expect(back).toHaveText('Pumps');
	await page.reload();
	await expect(back).toHaveText('Pumps');
	await back.click();
	await page.waitForURL(/\/admin\/pumps\?q=/);

	// Opened directly in a new tab: the usual parent.
	const fresh = await browser.newContext({ storageState: await page.context().storageState() });
	const direct = await fresh.newPage();
	await direct.goto(`/admin/pumps/${pump.id}`);
	await expect(direct.getByTestId('back-link')).toHaveText('Attendance records');
	await fresh.close();
});

// UI-20: the Attendance filters go Plant, then Pump (plant manager) and Area, Plant, Pump (admin):
// each list holds only what is inside the one chosen above it (2026-11-26).
test('UI-20 attendance filters narrow plant then pump', async ({ page }) => {
	const a = await createArea();
	const b = await createArea();
	const { rows } = await db.query(
		'INSERT INTO plants (area_id, name) VALUES ($1, $2) RETURNING id, name',
		[a.areaId, `${a.areaId.slice(0, 6)}-PLANT2`]
	);
	const plant2 = rows[0].id as string;
	const pumpA = await createPump(a.plantId);
	const pumpA2 = await createPump(plant2);
	const pumpB = await createPump(b.plantId);
	const options = (testId: string) =>
		page
			.getByTestId(testId)
			.locator('option')
			.evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value).filter(Boolean));

	// Admin: Area narrows Plant and Pump, Plant narrows Pump, changing Area clears the rest.
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, (await createAdmin()).email);
	await page.goto('/admin/attendance');
	await page.getByTestId('admin-area-filter').selectOption(a.areaId);
	expect((await options('admin-plant-filter')).sort()).toEqual([a.plantId, plant2].sort());
	expect((await options('admin-pump-filter')).sort()).toEqual([pumpA.id, pumpA2.id].sort());
	await page.getByTestId('admin-plant-filter').selectOption(plant2);
	expect(await options('admin-pump-filter')).toEqual([pumpA2.id]);
	await page.getByTestId('admin-pump-filter').selectOption(pumpA2.id);
	await page.getByTestId('admin-area-filter').selectOption(b.areaId);
	await expect(page.getByTestId('admin-plant-filter')).toHaveValue('');
	await expect(page.getByTestId('admin-pump-filter')).toHaveValue('');
	expect(await options('admin-pump-filter')).toEqual([pumpB.id]);
	await noSidewaysScroll(page);

	// Plant manager of both plants of Area A: Plant narrows Pump, kept after the page applies it.
	const manager = await createPlantManager(a.plantId);
	await db.query('INSERT INTO plant_manager_assignments (plant_id, manager_id) VALUES ($1, $2)', [
		plant2,
		manager.id
	]);
	await page.context().clearCookies();
	await signIn(page, manager.email);
	await page.goto('/plant-manager/attendance');
	expect((await options('pm-pump-filter')).sort()).toEqual([pumpA.id, pumpA2.id].sort());
	await page.getByTestId('pm-plant-filter').selectOption(plant2);
	await page.waitForURL(new RegExp(`plant=${plant2}`));
	expect(await options('pm-pump-filter')).toEqual([pumpA2.id]);
	await expect(page.getByTestId('pm-plant-filter')).toHaveValue(plant2);
	await page.screenshot({
		path: 'artifacts/pm-split/attendance-plant-filter-phone.png',
		fullPage: false
	});
});
