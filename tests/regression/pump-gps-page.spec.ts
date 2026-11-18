// LOC-16: the Pump GPS page (/admin/pump-gps, 2026-11-18: "Show the GPS Data as it refreshes in
// our dashboard ... and also keep a redirect link to google maps for seeing the actual location").
// Every pump's latest position by Area and plant, problems first, Fresh / Too old / No GPS with the
// time and age, positions in 24 h, a Google Maps link; it refreshes itself every minute.
import { expect, test } from '@playwright/test';
import { createAdmin, createArea, createPlantManager, createPump, db, login } from './helpers';
import { noSidewaysScroll, signIn } from './regularisationHelpers';

async function position(
	pumpId: string,
	lat: number,
	lng: number,
	minutesAgo: number,
	source = 'gps_api'
) {
	await db.query(
		`INSERT INTO pump_locations (pump_id, lat, lng, recorded_at, source)
		 VALUES ($1, $2, $3, now() - make_interval(mins => $4), $5)`,
		[pumpId, lat, lng, minutesAgo, source]
	);
}

test('LOC-16 the Pump GPS page shows each pump, problems first, with a Google Maps link', async ({
	page
}) => {
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(String(e)));
	page.on('console', (m) => {
		if (m.type() === 'error') problems.push(m.text());
	});
	const admin = await createAdmin();
	const { areaId, plantId } = await createArea();
	await db.query('UPDATE areas SET location_check_enabled = true WHERE id = $1', [areaId]);
	const fresh = await createPump(plantId);
	const old = await createPump(plantId);
	const none = await createPump(plantId);
	const renamed = await createPump(plantId);
	const tracker = `TRK-${renamed.code}`;
	await db.query('UPDATE pumps SET gps_device_id = $1 WHERE id = $2', [tracker, renamed.id]);
	await position(fresh.id, 19.0596, 72.9165, 30);
	await position(fresh.id, 19.0601, 72.917, 3); // the latest one counts
	await position(old.id, 19.2614, 73.1658, 125);
	await position(renamed.id, 19.009, 72.8495, 1, 'admin');

	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, admin.email);
	await page.goto(`/admin/pump-gps?area=${areaId}`);
	await expect(page.getByRole('heading', { name: 'Pump GPS', level: 1 })).toBeVisible();
	await expect(page.getByTestId('gps-live')).toContainText('Refreshes every minute.');

	const rows = page.getByTestId('gps-row');
	// Problems first: no GPS, too old, then fresh.
	await expect(rows).toHaveCount(4);
	expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))).toEqual([
		'none',
		'old',
		'fresh',
		'fresh'
	]);
	const row = (code: string) => page.locator(`[data-testid="gps-row"][data-pump="${code}"]`);
	await expect(row(none.code)).toContainText('No GPS');
	await expect(row(none.code)).toContainText(`Nothing received from ${none.code}`);
	await expect(row(none.code).getByTestId('gps-map')).toHaveCount(0);
	await expect(row(old.code)).toContainText('Too old');
	await expect(row(old.code)).toContainText('2 h 5 min ago');
	await expect(row(fresh.code)).toContainText('Fresh');
	await expect(row(fresh.code)).toContainText('3 min ago');
	await expect(row(fresh.code).getByTestId('gps-count')).toContainText('2');
	await expect(row(renamed.code).getByTestId('gps-tracker')).toHaveText(`GPS from ${tracker}`);
	await expect(row(renamed.code)).toContainText('entered by admin');
	await expect(page.getByTestId('gps-area-group')).toContainText('2 fresh, 1 too old, 1 no GPS');

	// The Google Maps link opens the latest position in a new tab.
	const map = row(fresh.code).getByTestId('gps-map');
	await expect(map).toHaveAttribute(
		'href',
		'https://www.google.com/maps/search/?api=1&query=19.0601,72.917'
	);
	await expect(map).toHaveAttribute('target', '_blank');
	await expect(map).toHaveAttribute('rel', /noopener/);
	await noSidewaysScroll(page);
	await page.screenshot({
		path: 'artifacts/deep-build/screenshots/pump-gps-page-mobile.png',
		fullPage: true
	});

	// The chips filter by GPS state, with their counts; All brings everything back.
	await expect(page.getByTestId('gps-chip-none')).toContainText('1');
	await page.getByTestId('gps-chip-none').click();
	await expect(page).toHaveURL(/gps=none/);
	await expect(rows).toHaveCount(1);
	await expect(page.getByTestId('gps-chip-none')).toHaveAttribute('aria-pressed', 'true');
	await page.getByTestId('gps-chip-all').click();
	await expect(rows).toHaveCount(4);
	// Search finds a pump by its tracker name too.
	await page.getByTestId('gps-search').fill(tracker);
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toHaveAttribute('data-pump', renamed.code);

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(`/admin/pump-gps?area=${areaId}`);
	await expect(rows).toHaveCount(4);
	await page.screenshot({ path: 'artifacts/deep-build/screenshots/pump-gps-page-desktop.png' });
	expect(problems).toEqual([]);
});

test('LOC-16 the page refreshes by itself every minute, and on Refresh now', async ({ page }) => {
	const admin = await createAdmin();
	const { areaId, plantId } = await createArea();
	const pump = await createPump(plantId);
	await page.clock.install();
	await signIn(page, admin.email);
	await page.goto(`/admin/pump-gps?area=${areaId}`);
	// The refresh timer starts once the page runs in the browser.
	await expect(page.getByTestId('gps-live')).toHaveAttribute('data-ready', 'true');
	const row = page.locator(`[data-testid="gps-row"][data-pump="${pump.code}"]`);
	await expect(row).toContainText('No GPS');

	// The worker copies a position; half a minute later nothing has changed yet...
	await position(pump.id, 19.0596, 72.9165, 2);
	await page.clock.runFor(30_000);
	await expect(row).toContainText('No GPS');
	// ...and once the minute is up the page shows it without a reload.
	await page.clock.runFor(31_000);
	await expect(row).toContainText('Fresh');
	await expect(row).toContainText('2 min ago');

	// Refresh now picks up the next one at once.
	await position(pump.id, 19.07, 72.92, 0);
	await page.getByTestId('gps-refresh').click();
	await expect(row).toContainText('just now');
	await expect(row.getByTestId('gps-map')).toHaveAttribute('href', /query=19\.07,72\.92$/);
});

test('LOC-16 only admins can open the Pump GPS page', async () => {
	const { plantId } = await createArea();
	const manager = await login((await createPlantManager(plantId)).email);
	const response = await manager.get('/admin/pump-gps', { maxRedirects: 0 });
	expect([302, 303, 403]).toContain(response.status());
	expect(await response.text()).not.toContain('Refreshes every minute');
});
