// SET-06: CC by area (2026-11-17: "I want a configurable CC Area wise with proper search bar also
// to search for that area, Don't show all the Areas in CC for area wise only show top 4 on type
// and default 5"; "Yes I want global CC and Area CC seperately"). Each Area has its own CC list
// for its 9 am email (area_digest_cc, migration 053), beside the global CC. Settings shows 5 areas
// before anything is typed and the 4 best matches while typing. Worker test:
// tests/unit/attendanceDigest.test.ts.
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { action, createAdmin, createArea, createPlantManager, db, login } from './helpers';
import { noSidewaysScroll, signIn } from './regularisationHelpers';

const areaCc = async (areaId: string) =>
	(
		await db.query('SELECT email FROM area_digest_cc WHERE area_id = $1 ORDER BY email', [areaId])
	).rows.map((r) => r.email);

const globalCc = async () =>
	(await db.query("SELECT value FROM app_settings WHERE key = 'digest_cc'")).rows[0]?.value ?? null;

async function namedArea(name: string) {
	const { rows } = await db.query('INSERT INTO areas (name) VALUES ($1) RETURNING id', [name]);
	return rows[0].id as string;
}

const cards = (page: Page) => page.getByTestId('area-cc').getByTestId('digest-area');

test('SET-06 5 areas before typing, the 4 best matches while typing', async ({ page }) => {
	const admin = await createAdmin();
	const key = `Ccx${randomUUID().slice(0, 6)}`;
	// Five areas starting with the key and one that only contains it.
	for (const n of ['One', 'Two', 'Three', 'Four', 'Five']) await namedArea(`${key} ${n}`);
	await namedArea(`West ${key}`);

	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, admin.email);
	await page.goto('/admin/settings');
	const search = page.getByTestId('area-cc-search');
	await search.scrollIntoViewIfNeeded();
	await expect(cards(page)).toHaveCount(5);
	await expect(page.getByTestId('area-cc-count')).toContainText('Showing 5 of');

	await search.fill(key.toLowerCase());
	await expect(cards(page)).toHaveCount(4);
	await expect(page.getByTestId('area-cc-count')).toContainText('Best 4 matches');
	for (const name of await cards(page).evaluateAll((els) =>
		els.map((e) => e.getAttribute('data-area') ?? '')
	))
		expect(name.startsWith(key), name).toBe(true);

	// A name that only contains the text still comes up when it is among the best.
	await search.fill(`west ${key.toLowerCase()}`);
	await expect(cards(page)).toHaveCount(1);
	await expect(cards(page).first()).toHaveAttribute('data-area', `West ${key}`);

	await search.fill('no area is called this');
	await expect(cards(page)).toHaveCount(0);
	await expect(page.getByTestId('area-cc-count')).toContainText('No area matches');
	await search.fill('');
	await expect(cards(page)).toHaveCount(5);
});

test('SET-06 an admin adds and removes an area CC, separate from the global CC', async ({
	page
}) => {
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(String(e)));
	page.on('console', (m) => {
		if (m.type() === 'error') problems.push(m.text());
	});
	const admin = await createAdmin();
	const { areaId } = await createArea();
	const { rows } = await db.query('SELECT name FROM areas WHERE id = $1', [areaId]);
	const areaName = rows[0].name as string;
	const globalBefore = await globalCc();

	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, admin.email);
	await page.goto('/admin/settings');
	const search = page.getByTestId('area-cc-search');
	await search.fill(areaName);
	const card = page.locator(`[data-testid="digest-area"][data-area="${areaName}"]`);
	await expect(card.getByTestId('digest-area-cc')).toContainText('No one yet.');

	// Two at once, one in capitals: stored lower case; the search stays.
	await card.getByTestId('area-cc-add').fill('Area.One@rdc.in, area.two@rdc.in');
	await card.getByRole('button', { name: 'Add' }).click();
	await expect(card.getByRole('status')).toContainText(
		`Added area.one@rdc.in, area.two@rdc.in for ${areaName}.`
	);
	await expect(search).toHaveValue(areaName);
	await expect(card.getByTestId('area-cc-add')).toHaveValue('');
	expect(await areaCc(areaId)).toEqual(['area.one@rdc.in', 'area.two@rdc.in']);
	expect(await globalCc()).toEqual(globalBefore);

	// Still there after a reload.
	await page.reload();
	await search.fill(areaName);
	await expect(card.getByTestId('digest-area-cc').locator('li')).toHaveCount(2);
	await noSidewaysScroll(page);
	await page
		.getByTestId('area-cc')
		.screenshot({ path: 'artifacts/deep-build/screenshots/area-cc-mobile.png' });

	await card.getByRole('button', { name: `Remove area.two@rdc.in from ${areaName}` }).click();
	await expect(card.getByRole('status')).toContainText(`Removed area.two@rdc.in for ${areaName}.`);
	expect(await areaCc(areaId)).toEqual(['area.one@rdc.in']);
	const { rows: audit } = await db.query(
		`SELECT details FROM admin_audit_log WHERE action = 'update_area_cc' AND target_id = $1
		 ORDER BY created_at`,
		[areaId]
	);
	expect(audit.map((r) => r.details)).toEqual([
		{ area: areaName, added: ['area.one@rdc.in', 'area.two@rdc.in'] },
		{ area: areaName, removed: ['area.two@rdc.in'] }
	]);

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.getByTestId('area-cc').scrollIntoViewIfNeeded();
	await page.screenshot({ path: 'artifacts/deep-build/screenshots/area-cc-desktop.png' });
	expect(problems).toEqual([]);
});

test('SET-06 a wrong address or a repeat adds nothing and says why', async ({ page }) => {
	const admin = await createAdmin();
	const { areaId } = await createArea();
	const { rows } = await db.query('SELECT name FROM areas WHERE id = $1', [areaId]);
	await db.query("INSERT INTO area_digest_cc (area_id, email) VALUES ($1, 'cc@rdc.in')", [areaId]);
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, admin.email);
	await page.goto('/admin/settings');
	await page.getByTestId('area-cc-search').fill(rows[0].name);
	const card = page.locator(`[data-testid="digest-area"][data-area="${rows[0].name}"]`);

	await card.getByTestId('area-cc-add').fill('not-an-email');
	await card.getByRole('button', { name: 'Add' }).click();
	await expect(card.getByRole('status')).toContainText('Not an email address: not-an-email');
	await card.getByTestId('area-cc-add').fill('CC@rdc.in');
	await card.getByRole('button', { name: 'Add' }).click();
	await expect(card.getByRole('status')).toContainText('Already copied for this area.');
	expect(await areaCc(areaId)).toEqual(['cc@rdc.in']);
});

test('SET-06 only an admin can change an area CC', async () => {
	const { areaId, plantId } = await createArea();
	const manager = await createPlantManager(plantId);
	const api = await login(manager.email);
	const response = await action(api, '/admin/settings?/addAreaCc', {
		area: areaId,
		email: 'sneaky@rdc.in'
	});
	expect(response.type).not.toBe('success');
	expect(await areaCc(areaId)).toEqual([]);
});
