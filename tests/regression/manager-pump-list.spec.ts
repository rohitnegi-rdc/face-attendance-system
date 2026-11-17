// ADM-16: a plant manager's day checklist and Pumps page, and a monitor's Pumps page, list only the
// pumps Active or Idle that day, each with that status, coloured like the admin Area list (ADM-14):
// light red when nobody is counted, the tint plus a red edge when there is fraud.
import { expect, test, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createAdmin, createArea, createPlantManager, createPump, db } from './helpers';
import { daysAgo, noSidewaysScroll, signIn } from './regularisationHelpers';

const TINT = 'rgb(253, 236, 234)';

const setStatus = (pumpId: string, day: string, status: string, adminId: string) =>
	db.query(
		`INSERT INTO pump_day_status (pump_id, day, status, set_by_role, set_by_id, set_by_name)
		 VALUES ($1, $2, $3, 'admin', $4, 'Regression')`,
		[pumpId, day, status, adminId]
	);

async function counted(pumpId: string) {
	const { rows } = await db.query(
		`INSERT INTO persons (pump_id, display_seq, name) VALUES ($1, 1, 'Crew 1') RETURNING id`,
		[pumpId]
	);
	await db.query(
		`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched, evening_matched)
		 VALUES ($1, $2, $3, true, true)`,
		[rows[0].id, pumpId, daysAgo(0)]
	);
	return rows[0].id as string;
}

const session = async (pumpId: string) =>
	(
		await db.query(
			`INSERT INTO attendance_sessions (pump_id, session_date, session_type, status, photo_hash)
			 VALUES ($1, $2, 'morning', 'completed', $3) RETURNING id`,
			[pumpId, daysAgo(0), randomUUID()]
		)
	).rows[0].id as string;

async function setup() {
	const admin = await createAdmin();
	const { areaId, plantId } = await createArea();
	const [active, idle, fraud, wentInactive, noStatus, fromTomorrow] = await Promise.all(
		Array.from({ length: 6 }, () => createPump(plantId))
	);
	await setStatus(active.id, daysAgo(5), 'active', admin.id);
	await setStatus(idle.id, daysAgo(0), 'idle', admin.id);
	await setStatus(fraud.id, daysAgo(0), 'active', admin.id);
	await setStatus(wentInactive.id, daysAgo(5), 'active', admin.id);
	await setStatus(wentInactive.id, daysAgo(1), 'inactive', admin.id);
	await setStatus(fromTomorrow.id, daysAgo(-1), 'active', admin.id);
	const activePerson = await counted(active.id);
	await counted(fraud.id);
	await db.query(
		`INSERT INTO fraud_flags (session_id, person_id, matched_at_pump_id, matched_session_id,
		                          similarity_score, reviewed, resolution)
		 VALUES ($1, $2, $3, $4, 0.9, false, NULL)`,
		[await session(fraud.id), activePerson, active.id, await session(active.id)]
	);
	return {
		areaId,
		plantId,
		shown: { active, idle, fraud },
		hidden: [wentInactive, noStatus, fromTomorrow]
	};
}

const bg = (row: Locator) => row.evaluate((el) => getComputedStyle(el).backgroundColor);
const firstCellBg = (row: Locator) =>
	row
		.locator('td')
		.first()
		.evaluate((el) => getComputedStyle(el).backgroundColor);

test('ADM-16 plant manager checklist and Pumps page list only Active and Idle pumps, coloured', async ({
	page
}) => {
	const { plantId, shown, hidden } = await setup();
	const manager = await createPlantManager(plantId);
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, manager.email);

	// Home: the day's checklist.
	await page.goto('/plant-manager');
	const items = page.getByTestId('checklist-pump');
	await expect(items).toHaveCount(3);
	const item = (code: string) => items.filter({ hasText: code });
	await expect(item(shown.active.code)).toHaveAttribute('data-status', 'active');
	await expect(item(shown.active.code)).toContainText('Active');
	await expect(item(shown.idle.code)).toHaveAttribute('data-status', 'idle');
	await expect(item(shown.idle.code)).toContainText('Idle');
	expect(await bg(item(shown.idle.code))).toBe(TINT);
	expect(await bg(item(shown.active.code))).not.toBe(TINT);
	expect(await bg(item(shown.fraud.code))).toBe(TINT);
	expect(await item(shown.fraud.code).evaluate((el) => getComputedStyle(el).boxShadow)).toContain(
		'inset'
	);
	for (const pump of hidden) await expect(item(pump.code)).toHaveCount(0);
	await noSidewaysScroll(page);
	await page.screenshot({ path: 'artifacts/pump-list/manager-checklist-mobile.png', fullPage: true });

	// Pumps page.
	await page.goto('/plant-manager/pumps');
	const rows = page.getByTestId('pm-pump-row');
	await expect(rows).toHaveCount(3);
	const row = (code: string) => rows.filter({ hasText: code });
	await expect(row(shown.active.code)).toContainText('Active');
	await expect(row(shown.idle.code)).toContainText('Idle');
	await expect(row(shown.idle.code)).toHaveAttribute('data-attendance', 'none');
	expect(await firstCellBg(row(shown.idle.code))).toBe(TINT);
	expect(await firstCellBg(row(shown.active.code))).not.toBe(TINT);
	expect(await firstCellBg(row(shown.fraud.code))).toBe(TINT);
	await expect(row(shown.fraud.code)).toContainText('1 fraud');
	for (const pump of hidden) await expect(row(pump.code)).toHaveCount(0);
	await page.screenshot({ path: 'artifacts/pump-list/manager-pumps-mobile.png', fullPage: true });
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.screenshot({ path: 'artifacts/pump-list/manager-pumps-desktop.png', fullPage: true });
	await page.goto('/plant-manager');
	await page.screenshot({
		path: 'artifacts/pump-list/manager-checklist-desktop.png',
		fullPage: true
	});
});

test('ADM-16 a monitor sees only the Active and Idle pumps of its Area', async ({ page }) => {
	const { areaId, plantId, shown, hidden } = await setup();
	const monitor = await createPlantManager(plantId);
	await db.query('UPDATE plant_managers SET is_monitor = true WHERE id = $1', [monitor.id]);
	await db.query('DELETE FROM plant_manager_assignments WHERE manager_id = $1', [monitor.id]);
	await db.query('INSERT INTO monitor_areas (manager_id, area_id) VALUES ($1, $2)', [
		monitor.id,
		areaId
	]);
	await signIn(page, monitor.email);
	await page.goto('/plant-manager/pumps');
	const rows = page.getByTestId('pm-pump-row');
	await expect(rows).toHaveCount(3);
	for (const pump of Object.values(shown))
		await expect(rows.filter({ hasText: pump.code })).toHaveCount(1);
	for (const pump of hidden) await expect(rows.filter({ hasText: pump.code })).toHaveCount(0);
});
