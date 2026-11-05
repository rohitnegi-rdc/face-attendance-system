// UI-13: a new pump's first visit opens the guide. It closes at any step (X or Escape) and switches
// between Hindi and English. Closing or finishing it once is saved on the server: it does not
// open by itself again, and only the Help button reopens it.
import { test, expect, type Page } from '@playwright/test';
import { BASE_URL, PASSWORD, createArea, createPump, db } from './helpers';

async function newPumpOnScreen(page: Page) {
	const { plantId } = await createArea();
	const pump = await createPump(plantId, undefined, { guideDone: false });
	const response = await page.request.post('/api/auth/login', {
		data: { email: pump.email, password: PASSWORD },
		headers: { origin: BASE_URL }
	});
	expect(response.status()).toBe(200);
	await page.goto('/pump');
	return pump;
}

async function expectSaved(pumpId: string) {
	await expect
		.poll(async () => {
			const { rows } = await db.query('SELECT guide_done_at FROM pumps WHERE id = $1', [pumpId]);
			return rows[0].guide_done_at !== null;
		})
		.toBe(true);
}

test('UI-13 a new pump can close the guide at the first step; it stays closed, Help reopens it', async ({
	page
}) => {
	const pump = await newPumpOnScreen(page);
	const guide = page.getByTestId('pump-guide');
	await expect(guide).toBeVisible();
	await expect(page.getByTestId('guide-title')).toHaveText('पंप ऑपरेटर की फोटो लें');
	await page.getByTestId('guide-close').click();
	await expect(guide).toHaveCount(0);
	await expectSaved(pump.id);

	// The next visit goes straight to the screen: Help can only be tapped with no guide over it.
	await page.reload();
	await page.getByTestId('guide-help').click();
	await expect(guide).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(guide).toHaveCount(0);
	await page.getByTestId('guide-help').click();
	await page.getByTestId('guide-close').click();
	await expect(guide).toHaveCount(0);
});

test('UI-13 the guide switches language, and finishing it also stops it opening', async ({
	page
}) => {
	const pump = await newPumpOnScreen(page);
	const guide = page.getByTestId('pump-guide');
	await page.getByTestId('guide-lang').click();
	await expect(page.getByTestId('guide-title')).toHaveText('Take the Pump Operator photo');
	await expect(guide.getByText('Take Pump Operator photo').first()).toBeVisible();

	const next = page.getByTestId('guide-next');
	for (let step = 1; step < 4; step++) await next.click();
	await expect(page.getByTestId('guide-title')).toHaveText('Close the shift after 9 hours');
	await expect(next).toHaveText(/Start/);
	await next.click();
	await expect(guide).toHaveCount(0);
	await expectSaved(pump.id);

	await page.reload();
	await page.getByTestId('guide-help').click();
	await expect(guide).toBeVisible();
});

// The four steps word for word as the user wrote them (2026-10-27), with the footer under every
// step, in Hindi and in English, at phone width.
const STEPS = {
	hi: [
		[
			'पंप ऑपरेटर की फोटो लें',
			'"पंप ऑपरेटर फोटो लें" बटन पर क्लिक करें। फोटो में केवल ऑपरेटर हों और उनका चेहरा साफ़ दिखे।'
		],
		[
			'सभी पंप मेंबर्स की फोटो लें',
			'"पंप मेंबर्स फोटो लें" बटन पर क्लिक करें। सभी मेंबर्स के चेहरे साफ़ दिखाई दें।'
		],
		[
			'फोटो भेजें और नाम लिखें',
			'"फोटो भेजें" बटन पर क्लिक करें। फिर सभी मेंबर्स के पूरे नाम लिखकर "रिव्यू पूरा" दबाएँ। आपकी शिफ्ट शुरू हो जाएगी।'
		],
		[
			'9 घंटे बाद शिफ्ट बंद करें',
			'9 घंटे बाद ऑपरेटर और सभी मेंबर्स की दोबारा फोटो लेकर भेजें। फिर "रिव्यू पूरा" दबाएँ। शिफ्ट बंद हो जाएगी।'
		]
	],
	en: [
		[
			'Take the Pump Operator photo',
			'Tap the "Take Pump Operator photo" button. Only the operator should be in the photo, with the face clearly visible.'
		],
		[
			'Take the photo of all Pump Members',
			'Tap the "Take Pump Members photo" button. Every member\'s face should be clearly visible.'
		],
		[
			'Send the photos and write the names',
			'Tap the "Submit photos" button. Then write the full names of all members and tap "Done reviewing". Your shift will start.'
		],
		[
			'Close the shift after 9 hours',
			'After 9 hours, take and send the photos of the operator and all members again. Then tap "Done reviewing". The shift will close.'
		]
	]
};
const FOOTER = {
	hi: 'कोई परेशानी हो तो "मदद" बटन दबाएँ।',
	en: 'Any problem? Tap the "Help" button.'
};
const BUTTONS = {
	hi: ['पंप ऑपरेटर फोटो लें', 'पंप मेंबर्स फोटो लें', 'रिव्यू पूरा', 'रिव्यू पूरा'],
	en: ['Take Pump Operator photo', 'Take Pump Members photo', 'Done reviewing', 'Done reviewing']
};

test('UI-13 the guide is the four steps, in Hindi and English, with the help footer', async ({
	page
}, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const { plantId } = await createArea();
	const pump = await createPump(plantId, undefined, { guideDone: false });
	const response = await page.request.post('/api/auth/login', {
		data: { email: pump.email, password: PASSWORD },
		headers: { origin: BASE_URL }
	});
	expect(response.status()).toBe(200);
	await page.goto('/pump');
	const guide = page.getByTestId('pump-guide');
	const next = page.getByTestId('guide-next');
	const back = guide.getByRole('button', { name: /^(Back|पीछे)$/ });

	for (const lang of ['hi', 'en'] as const) {
		if (lang === 'en') await page.getByTestId('guide-lang').click();
		for (let i = 0; i < 4; i++) {
			await expect(page.getByTestId('guide-title')).toHaveText(STEPS[lang][i][0]);
			await expect(guide.locator('#guide-body')).toHaveText(STEPS[lang][i][1]);
			await expect(guide.locator('.guide-help-note')).toHaveText(FOOTER[lang]);
			await expect(guide.locator('.mock-button')).toHaveText(BUTTONS[lang][i]);
			// Nothing runs off the side of a phone.
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
			).toBe(true);
			// The step slides in; wait for that (not the looping pictures) before the screenshot.
			await page.evaluate(() =>
				Promise.all(
					document
						.getAnimations()
						.filter((a) => a.effect?.getTiming().iterations !== Infinity)
						.map((a) => a.finished)
				)
			);
			await page.screenshot({ path: testInfo.outputPath(`guide-${lang}-${i + 1}.png`) });
			if (i < 3) await next.click();
		}
		await expect(next).toHaveText(lang === 'hi' ? /स्टार्ट/ : /Start/);
		if (lang === 'hi') for (let i = 0; i < 3; i++) await back.click();
	}
});
