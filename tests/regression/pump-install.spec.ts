// APP-01: the RDC truck logo is the browser tab icon, the sign-in mark and the pump header mark,
// and the manifest names the app with its icons (the reminders use them). There is no Install
// app banner: notifications work from the web app directly (removed 2026-10-27).
import { expect, test } from '@playwright/test';
import { BASE_URL, PASSWORD, createArea, createPump } from './helpers';

test('APP-01 manifest and icons make the pump screen installable', async ({ request }) => {
	const html = await (await request.get('/login')).text();
	expect(html).toMatch(/<link rel="manifest" href="[^"]*manifest\.webmanifest"/);
	expect(html).toMatch(/<link rel="apple-touch-icon" href="[^"]*icons\/apple-touch-icon\.png"/);

	const manifest = await (await request.get('/manifest.webmanifest')).json();
	expect(manifest).toMatchObject({
		name: 'RDC Pump Attendance',
		start_url: './pump',
		display: 'standalone'
	});
	const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
	expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
	expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === 'maskable')).toBe(
		true
	);
	// The browser tab shows the RDC truck, not the Svelte logo.
	expect(html).toMatch(
		/<link rel="icon" type="image\/png" sizes="32x32" href="[^"]*icons\/favicon-32\.png"/
	);
	expect(html).not.toContain('favicon.svg');
	for (const file of [
		...manifest.icons.map((icon: { src: string }) => icon.src),
		'icons/apple-touch-icon.png',
		'icons/badge-96.png',
		'icons/favicon-32.png',
		'icons/favicon-48.png',
		'icons/favicon-96.png',
		'icons/logo-wide.png'
	]) {
		const response = await request.get(`/${file}`);
		expect(response.status(), file).toBe(200);
		expect(response.headers()['content-type'], file).toBe('image/png');
	}
});

test('APP-01 the RDC logo on sign in and in the pump header, no install banner', async ({
	page
}, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	// The sign-in page and the pump header carry the RDC truck.
	await page.goto('/login');
	await expect(page.locator('.rdc-logo')).toHaveJSProperty('naturalWidth', 240);
	await page.screenshot({ path: testInfo.outputPath('logo-sign-in-390.png') });

	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const signedIn = await page.request.post('/api/auth/login', {
		data: { email: pump.email, password: PASSWORD },
		headers: { origin: BASE_URL }
	});
	expect(signedIn.status()).toBe(200);

	await page.goto('/pump');
	await page.getByTestId('guide-close').click();
	await expect(page.locator('.pump-topbar .rdc-logo')).toHaveJSProperty('naturalWidth', 240);
	// Logo, Help, language and sign out all fit one phone-wide header.
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true
	);
	await expect(page.getByTestId('pump-install')).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath('pump-header-390.png') });
});
