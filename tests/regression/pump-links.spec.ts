// LINK: a pump's direct sign-in link, made and revoked by an admin at /admin/pump-links, listed by
// Area and plant. SRCH: admin search follows each key press, with no Search button.
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
	BASE_URL,
	PASSWORD,
	action,
	anonymous,
	createAdmin,
	createArea,
	createPlantManager,
	createPump,
	db,
	login
} from './helpers';

const PAGE = '/admin/pump-links';

async function linkOf(admin: APIRequestContext, pumpId: string) {
	const result = await action(admin, `${PAGE}?/generate`, { pump: pumpId });
	expect(result.type).toBe('success');
	const { rows } = await db.query(
		'SELECT id FROM pump_login_links WHERE pump_id = $1 AND revoked_at IS NULL',
		[pumpId]
	);
	expect(rows).toHaveLength(1);
	const page = await (await admin.get(PAGE)).text();
	const found = page.match(new RegExp(`/link/${rows[0].id}\\.[\\w-]+`));
	expect(found, 'the page shows the link').not.toBeNull();
	return found![0];
}

test('LINK-01 the link signs the pump in directly; generating twice keeps the same link', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const admin = await login((await createAdmin()).email);
	const link = await linkOf(admin, pump.id);
	expect(await linkOf(admin, pump.id)).toBe(link);

	const phone = await anonymous();
	const opened = await phone.get(link, { maxRedirects: 0 });
	expect(opened.status()).toBe(303);
	expect(opened.headers().location).toMatch(/\/pump$/);
	expect((await phone.get('/pump', { maxRedirects: 0 })).status()).toBe(200);
	expect((await phone.get('/api/attendance/today')).status()).toBe(200);
	// It is that pump's session and nothing more.
	expect((await phone.get('/admin/pumps', { maxRedirects: 0 })).status()).toBe(403);
});

test('LINK-02 revoking stops the link and its session; the password and a new link still work', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const adminUser = await createAdmin();
	const admin = await login(adminUser.email);
	const link = await linkOf(admin, pump.id);
	const phone = await anonymous();
	await phone.get(link, { maxRedirects: 0 });
	const withPassword = await login(pump.email, PASSWORD);

	expect((await action(admin, `${PAGE}?/revoke`, { pump: pump.id })).type).toBe('success');

	const signedOut = await phone.get('/pump', { maxRedirects: 0 });
	expect(signedOut.status()).toBe(302);
	expect(signedOut.headers().location).toContain('/login');
	const dead = await (await anonymous()).get(link, { maxRedirects: 0 });
	expect(dead.status()).toBe(200);
	expect(await dead.text()).toContain('This link no longer works');
	expect((await withPassword.get('/pump', { maxRedirects: 0 })).status()).toBe(200);

	const { rows } = await db.query(
		`SELECT action FROM admin_audit_log WHERE target_id = $1 AND admin_id = $2 ORDER BY created_at`,
		[pump.id, adminUser.id]
	);
	expect(rows.map((row) => row.action)).toEqual(['pump_link_created', 'pump_link_revoked']);

	const fresh = await linkOf(admin, pump.id);
	expect(fresh).not.toBe(link);
	expect((await (await anonymous()).get(fresh, { maxRedirects: 0 })).status()).toBe(303);
	expect((await (await anonymous()).get(link, { maxRedirects: 0 })).status()).toBe(200);
});

test('LINK-03 a changed link, a disabled pump and another login are refused', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const admin = await login((await createAdmin()).email);
	const link = await linkOf(admin, pump.id);

	const stranger = await anonymous();
	const changed = await stranger.get(`${link.slice(0, -2)}xx`, { maxRedirects: 0 });
	expect(changed.status()).toBe(200);
	expect(await changed.text()).toContain('This link no longer works');
	expect((await stranger.get('/pump', { maxRedirects: 0 })).status()).toBe(302);

	// An admin who opens the link stays the admin.
	const asAdmin = await admin.get(link, { maxRedirects: 0 });
	expect(await asAdmin.text()).toContain('You are signed in with another account');
	expect((await admin.get(PAGE, { maxRedirects: 0 })).status()).toBe(200);

	await db.query(`UPDATE pumps SET status = 'disabled' WHERE id = $1`, [pump.id]);
	const disabled = await (await anonymous()).get(link, { maxRedirects: 0 });
	expect(await disabled.text()).toContain('This pump is disabled');
});

test('LINK-04 only an admin manages links; the Area filter lists only that Area', async () => {
	const first = await createArea();
	const second = await createArea();
	const pumpA = await createPump(first.plantId);
	const pumpB = await createPump(second.plantId);
	const admin = await login((await createAdmin()).email);
	const manager = await login((await createPlantManager(first.plantId)).email);

	expect((await manager.get(PAGE, { maxRedirects: 0 })).status()).toBe(403);
	expect((await action(manager, `${PAGE}?/generate`, { pump: pumpA.id })).httpStatus).toBe(403);
	expect((await (await anonymous()).get(PAGE, { maxRedirects: 0 })).status()).toBe(302);

	const areaOf = await db.query(
		'SELECT pl.area_id FROM plants pl JOIN pumps pu ON pu.plant_id = pl.id WHERE pu.id = $1',
		[pumpA.id]
	);
	const filtered = await (await admin.get(`${PAGE}?area=${areaOf.rows[0].area_id}`)).text();
	expect(filtered).toContain(pumpA.code);
	expect(filtered).not.toContain(pumpB.code);
});

test('LINK-06 the link session has no end date; it ends on logout or when the pump is disabled', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const admin = await login((await createAdmin()).email);
	const link = await linkOf(admin, pump.id);
	const phone = await anonymous();

	const opened = await phone.get(link, { maxRedirects: 0 });
	const cookie = opened.headers()['set-cookie'];
	expect(cookie).toContain(`Max-Age=${60 * 60 * 24 * 400}`);
	const session = cookie.match(/session(?:_http)?=([^;]+)/)![1];
	const claims = JSON.parse(Buffer.from(session.split('.')[1], 'base64url').toString());
	expect(claims.linkId).toBeTruthy();
	expect(claims.exp).toBeUndefined();

	// Every page opened gives the cookie its full life again.
	const screen = await phone.get('/pump', { maxRedirects: 0 });
	expect(screen.status()).toBe(200);
	expect(screen.headers()['set-cookie']).toContain(`Max-Age=${60 * 60 * 24 * 400}`);

	// Logging out really signs out, and the link signs in again.
	const out = await phone.post('/api/auth/logout', {
		headers: { origin: BASE_URL },
		maxRedirects: 0
	});
	expect(out.status()).toBe(303);
	expect((await phone.get('/pump', { maxRedirects: 0 })).status()).toBe(302);
	expect((await phone.get(link, { maxRedirects: 0 })).status()).toBe(303);
	expect((await phone.get('/pump', { maxRedirects: 0 })).status()).toBe(200);

	// A disabled pump does not keep a session that would otherwise never end.
	await db.query(`UPDATE pumps SET status = 'disabled' WHERE id = $1`, [pump.id]);
	expect((await phone.get('/pump', { maxRedirects: 0 })).status()).toBe(302);
});

test('LINK-05 at phone width: generate, copy and revoke in the browser', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const adminUser = await createAdmin();
	await page.request.post('/api/auth/login', {
		data: { email: adminUser.email, password: PASSWORD },
		headers: { origin: BASE_URL }
	});
	await page.goto(`${PAGE}?q=${pump.code}`);
	const row = page.locator(`[data-testid="link-row"][data-pump="${pump.code}"]`);
	await row.getByTestId('link-generate').click();
	await expect(row.getByTestId('link-url')).toHaveValue(/\/link\//);
	await row.getByTestId('link-copy').click();
	await expect(row.getByTestId('link-copy')).toHaveText(/Copied/);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: test.info().outputPath('pump-links-390.png'), fullPage: true });
	page.on('dialog', (dialog) => dialog.accept());
	await row.getByTestId('link-revoke').click();
	await expect(row.getByTestId('link-generate')).toBeVisible();
});

test('SRCH-01 admin search follows each key press, with no Search button, and keeps the typing', async ({
	page
}) => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const other = await createPump(plantId);
	const adminUser = await createAdmin();
	await page.request.post('/api/auth/login', {
		data: { email: adminUser.email, password: PASSWORD },
		headers: { origin: BASE_URL }
	});
	await page.goto('/admin/pumps');
	await expect(page.getByRole('button', { name: 'Search', exact: true })).toHaveCount(0);
	const search = page.getByTestId('pump-search');
	await search.pressSequentially(pump.code, { delay: 40 });
	await expect(page).toHaveURL(new RegExp(`\\?q=${pump.code}$`));
	await expect(page.getByTestId('pump-total')).toContainText(`matching "${pump.code}"`);
	await expect(page.getByText(pump.code, { exact: true }).first()).toBeVisible();
	await expect(page.getByText(other.code, { exact: true })).toHaveCount(0);
	await expect(search).toHaveValue(pump.code);
	await expect(search).toBeFocused();

	// Clear empties the box and shows everything again.
	await page.getByRole('link', { name: 'Clear', exact: true }).click();
	await expect(search).toHaveValue('');
	await expect(page).toHaveURL(/\/admin\/pumps$/);

	// Every admin page with a search box works the same way.
	for (const [path, testId] of [
		['/admin/areas', 'area-search'],
		['/admin/plants', 'plant-search'],
		['/admin/vendors', 'vendor-search'],
		['/admin/pump-status', 'status-search'],
		[PAGE, 'link-search']
	]) {
		await page.goto(path);
		await page.getByTestId(testId).pressSequentially('zz', { delay: 30 });
		await expect(page, path).toHaveURL(/q=zz/);
		await expect(page.getByTestId(testId), path).toBeFocused();
	}
	await page.goto('/admin/logs');
	await page.getByPlaceholder('Pump code, message, request id').pressSequentially('zz');
	await expect(page).toHaveURL(/q=zz/);
	await page.locator('select[name="service"]').selectOption('worker');
	await expect(page).toHaveURL(/service=worker/);
	await expect(page).toHaveURL(/q=zz/);
});
