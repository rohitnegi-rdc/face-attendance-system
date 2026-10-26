// APP-01: the pump screen installs as an app (Android Chrome), so the shift end reminders come
// from an installed app with the RDC icon instead of a website Chrome may flag as spam. The
// manifest names the app and its icons; when Chrome says the app can be installed the pump
// screen shows Install app, which opens Chrome's install question and goes away once installed.
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
	for (const file of [
		...manifest.icons.map((icon: { src: string }) => icon.src),
		'icons/apple-touch-icon.png',
		'icons/badge-96.png'
	]) {
		const response = await request.get(`/${file}`);
		expect(response.status(), file).toBe(200);
		expect(response.headers()['content-type'], file).toBe('image/png');
	}
});

test('APP-01 Install app shows when Chrome offers it, installs on tap, then goes away', async ({
	page
}, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	// Chrome's "can be installed" announcement, answered "install" when its question is shown.
	await page.addInitScript(() => {
		const w = window as unknown as { installAsked: number };
		w.installAsked = 0;
		window.addEventListener('load', () => {
			setTimeout(() => {
				const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
					prompt: () => Promise<void>;
					userChoice: Promise<{ outcome: string }>;
				};
				event.prompt = async () => {
					w.installAsked++;
				};
				event.userChoice = Promise.resolve({ outcome: 'accepted' });
				window.dispatchEvent(event);
			}, 300);
		});
	});
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const signedIn = await page.request.post('/api/auth/login', {
		data: { email: pump.email, password: PASSWORD },
		headers: { origin: BASE_URL }
	});
	expect(signedIn.status()).toBe(200);

	await page.goto('/pump');
	await page.getByTestId('guide-close').click();
	const card = page.getByTestId('pump-install');
	await expect(card).toBeVisible();
	await expect(card.locator('img')).toHaveJSProperty('naturalWidth', 192);
	await page.screenshot({ path: testInfo.outputPath('install-card-390.png') });
	await page.getByTestId('pump-install-button').click();
	await expect.poll(() => page.evaluate(() => (window as any).installAsked)).toBe(1);
	await expect(card).toHaveCount(0);
});
