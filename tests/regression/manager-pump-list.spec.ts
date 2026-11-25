// ADM-16: a plant manager's day checklist and Pumps page, and a monitor's Pumps page, list only the
// pumps Active or Idle that day, each with that status, coloured like the admin Area list (ADM-14):
// light red when an Active pump has nobody counted (an Idle pump has no work, never red for it,
// 2026-11-25), the tint plus a red edge when there is fraud.
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
	const [active, idle, fraud, wentInactive, noStatus, fromTomorrow, empty] = await Promise.all(
		Array.from({ length: 7 }, () => createPump(plantId))
	);
	await setStatus(empty.id, daysAgo(0), 'active', admin.id);
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
		shown: { active, idle, fraud, empty },
		hidden: [wentInactive, noStatus, fromTomorrow]
	};
}

const bg = (row: Locator) => row.evaluate((el) => getComputedStyle(el).backgroundColor);

test('ADM-16 plant manager checklist and Pumps page list only Active and Idle pumps, coloured', async ({
	page
}) => {
	const { plantId, shown, hidden } = await setup();
	const manager = await createPlantManager(plantId);
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, manager.email);

	// The site typed under the status shows on the home card and on the Pumps card.
	await db.query(`UPDATE pump_day_status SET site_name = 'Hebbal flyover' WHERE pump_id = $1`, [
		shown.active.id
	]);
	// Home: the day's checklist, its date written the way people read it ("Wed, 25 Nov 2026").
	await page.goto('/plant-manager');
	await expect(page.locator('p.date')).toHaveText(/^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4}$/);
	const items = page.getByTestId('checklist-pump');
	await expect(items).toHaveCount(4);
	const item = (code: string) => items.filter({ hasText: code });
	await expect(item(shown.active.code).getByTestId('checklist-site')).toContainText(
		'Hebbal flyover'
	);
	await expect(item(shown.active.code)).toHaveAttribute('data-status', 'active');
	await expect(item(shown.active.code)).toContainText('Active');
	await expect(item(shown.idle.code)).toHaveAttribute('data-status', 'idle');
	await expect(item(shown.idle.code)).toContainText('Idle');
	expect(await bg(item(shown.empty.code))).toBe(TINT);
	expect(await bg(item(shown.idle.code))).not.toBe(TINT);
	// Idle with nobody is not a problem: listed under No problems, saying so.
	await expect(
		page
			.getByTestId('checklist-fine')
			.getByTestId('checklist-pump')
			.filter({ hasText: shown.idle.code })
	).toContainText('Idle, no work');
	await expect(
		page
			.getByTestId('checklist-todo')
			.getByTestId('checklist-pump')
			.filter({ hasText: shown.empty.code })
	).toContainText('No photo yet');
	expect(await bg(item(shown.active.code))).not.toBe(TINT);
	expect(await bg(item(shown.fraud.code))).toBe(TINT);
	expect(await item(shown.fraud.code).evaluate((el) => getComputedStyle(el).boxShadow)).toContain(
		'inset'
	);
	for (const pump of hidden) await expect(item(pump.code)).toHaveCount(0);
	await noSidewaysScroll(page);
	await page.screenshot({
		path: 'artifacts/pump-list/manager-checklist-mobile.png',
		fullPage: true
	});

	// Pumps page.
	await page.goto('/plant-manager/pumps');
	const rows = page.getByTestId('pm-pump-row');
	await expect(rows).toHaveCount(4);
	const row = (code: string) => rows.filter({ hasText: code });
	await expect(row(shown.active.code)).toContainText('Active');
	await expect(row(shown.idle.code)).toContainText('Idle');
	await expect(row(shown.idle.code)).toHaveAttribute('data-attendance', 'none');
	// Phone cards (2026-11-25): the light red rule of the checklist, Idle says no work.
	expect(await bg(row(shown.empty.code))).toBe(TINT);
	expect(await bg(row(shown.idle.code))).not.toBe(TINT);
	expect(await bg(row(shown.active.code))).not.toBe(TINT);
	expect(await bg(row(shown.fraud.code))).toBe(TINT);
	await expect(row(shown.fraud.code)).toContainText('1 fraud');
	await expect(row(shown.idle.code)).toContainText('Idle, no work');
	await expect(row(shown.active.code)).toContainText('Site: Hebbal flyover');
	await expect(row(shown.empty.code)).toContainText('Nobody counted today');
	for (const pump of hidden) await expect(row(pump.code)).toHaveCount(0);
	await noSidewaysScroll(page);
	await page.screenshot({ path: 'artifacts/pump-list/manager-pumps-mobile.png', fullPage: true });
	// Tapping a card opens the pump's day; its back link returns to Pumps.
	await row(shown.active.code).locator('a.pump__open').click();
	await expect(page).toHaveURL(new RegExp(`/plant-manager/pumps/${shown.active.id}\\?from=pumps$`));
	await expect(page.getByTestId('pm-pump-day-back')).toHaveText(/Pumps$/);
	await page.getByTestId('pm-pump-day-back').click();
	await expect(page).toHaveURL(/\/plant-manager\/pumps$/);
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
	await expect(rows).toHaveCount(4);
	for (const pump of Object.values(shown))
		await expect(rows.filter({ hasText: pump.code })).toHaveCount(1);
	for (const pump of hidden) await expect(rows.filter({ hasText: pump.code })).toHaveCount(0);
});

test('ADM-19 from Pumps today, Fix attendance and View attendance both come back to Pumps today', async ({
	page
}) => {
	const { plantId, shown } = await setup();
	const manager = await createPlantManager(plantId);
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, manager.email);
	await page.goto('/plant-manager');
	const card = page.getByTestId('checklist-pump').filter({ hasText: shown.active.code });

	// Tapping the pump opens Fix attendance; its back link says Pumps today and goes there.
	await card.locator('a.pump__open').click();
	await expect(page).toHaveURL(/\/plant-manager\/attendance\/correct\?.*from=overview/);
	const fixBack = page.locator('a.back-link');
	await expect(fixBack).toHaveText(/Pumps today/);
	await fixBack.click();
	await expect(page).toHaveURL(/\/plant-manager$/);

	// View attendance opens the pump's day: who was counted and the shift with its photos.
	await card.getByTestId('checklist-view').click();
	await expect(page).toHaveURL(new RegExp(`/plant-manager/pumps/${shown.active.id}$`));
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(shown.active.code);
	await expect(page.getByTestId('pm-pump-day-counted')).toContainText('1 worker counted');
	await expect(page.getByTestId('split-full')).toContainText('1');
	await expect(page.getByTestId('fix-attendance')).toHaveAttribute('href', /from=pump/);
	await noSidewaysScroll(page);
	await page.screenshot({
		path: 'artifacts/pump-list/manager-pump-day-mobile.png',
		fullPage: true
	});
	// Its Fix attendance comes back to the pump's day, and the pump's day back to Pumps today.
	await page.getByTestId('fix-attendance').first().click();
	await expect(page.locator('a.back-link')).toHaveText(new RegExp(shown.active.code));
	await page.locator('a.back-link').click();
	await expect(page).toHaveURL(new RegExp(`/plant-manager/pumps/${shown.active.id}$`));
	await page.getByTestId('pm-pump-day-back').click();
	await expect(page).toHaveURL(/\/plant-manager$/);

	// An Idle pump with no photo says no photo is expected.
	await page
		.getByTestId('checklist-pump')
		.filter({ hasText: shown.idle.code })
		.getByTestId('checklist-view')
		.click();
	await expect(page.getByText('no photo is expected')).toBeVisible();
});

test('ADM-19 a plant manager cannot open the day of a pump outside their plants', async ({
	page
}) => {
	const { shown } = await setup();
	const other = await createArea();
	const stranger = await createPlantManager(other.plantId);
	await signIn(page, stranger.email);
	const res = await page.goto(`/plant-manager/pumps/${shown.active.id}`);
	expect(res?.status()).toBe(404);
});
