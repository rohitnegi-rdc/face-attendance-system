// Screenshot tests of the pump's regularisation calendar. The sign-in is real; the calendar's data
// is a fixed month (12 Nov 2026) so every state is on screen and images never change with the date.
// The real data flow is covered by tests/regression/regularisation-calendar.spec.ts.
// Update baselines deliberately: npm run test:visual:update
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createArea, createPump } from '../regression/helpers';
import { signIn } from '../regression/regularisationHelpers';

// A plain 1 x 1 pixel stands in for every face: no real photo in the repository.
const FACE = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN88f/rfwAJTQO9bXQ0YgAAAABJRU5ErkJggg==',
	'base64'
);

const request = (status: string, extra: object = {}) => ({
	id: `00000000-0000-4000-8000-0000000000${status.length}`,
	status,
	decisionReason: null,
	decidedByName: null,
	decidedAt: null,
	...extra
});

function day(n: number, state: string, more: object = {}) {
	return {
		day: `2026-11-${String(n).padStart(2, '0')}`,
		state,
		note: null,
		canApply: false,
		counted: [],
		request: null,
		...more
	};
}

const DAYS = [
	day(1, 'none', { note: 'inactive' }),
	day(2, 'full', { counted: ['Ramesh', 'Suresh', 'Worker 3'] }),
	day(3, 'partial', {
		canApply: true,
		counted: ['Ramesh (start only)', 'Suresh (start only)', 'Worker 3']
	}),
	day(4, 'missed', { canApply: true }),
	day(5, 'waiting', { request: request('pending') }),
	day(6, 'regularised', {
		counted: ['Ramesh', 'Suresh'],
		request: request('approved', {
			decidedByName: 'Pawan Singh',
			decidedAt: 'Sat, 7 Nov 2026, 10:12 am'
		})
	}),
	day(7, 'rejected', {
		canApply: true,
		request: request('rejected', {
			decisionReason: 'The workers listed are not right',
			decidedByName: 'Pawan Singh',
			decidedAt: 'Sun, 8 Nov 2026, 9:40 am'
		})
	}),
	day(8, 'full', { counted: ['Ramesh', 'Suresh'] }),
	day(9, 'partial', { canApply: true, counted: ['Ramesh (end only)'] }),
	day(10, 'none', { note: 'open' }),
	day(11, 'missed', { canApply: true }),
	day(12, 'none', { note: 'today' }),
	...Array.from({ length: 18 }, (_, i) => day(13 + i, 'none', { note: 'future' }))
];

const MONTH = { month: '2026-11', minMonth: '2026-10', maxMonth: '2026-11', days: DAYS };

const half = (i: number, name: string, side: string) => ({
	personId: `00000000-0000-4000-8000-00000000000${i}`,
	label: name,
	ticked: true,
	half: side
});
const PARTIAL = {
	kind: 'partial',
	crew: [half(1, 'Ramesh', 'start'), half(2, 'Suresh', 'start'), half(3, 'Worker 3', 'end')]
};
const CREW_27 = {
	kind: 'missed',
	crew: Array.from({ length: 27 }, (_, i) => ({
		personId: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
		label: i % 5 === 0 ? `Mahendra Kumar ${i + 1}` : `Worker ${i + 1}`,
		ticked: i < 20,
		half: null
	}))
};

async function mock(page: Page, crew: object = PARTIAL) {
	await page.route('**/api/persons/*/face', (r) =>
		r.fulfill({ status: 200, contentType: 'image/png', body: FACE })
	);
	await page.route('**/api/pump/regularisation*', (r) => {
		const url = new URL(r.request().url());
		if (r.request().method() === 'POST') return r.fulfill({ json: { id: 'x', status: 'pending' } });
		if (url.searchParams.get('month')) return r.fulfill({ json: MONTH });
		if (url.searchParams.get('day')) return r.fulfill({ json: crew });
		return r.fulfill({ json: { days: [], requests: [], month: '2026-11' } });
	});
}

async function open(page: Page, width: number, height: number, english = false, crew?: object) {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	if (english) await page.addInitScript(() => localStorage.setItem('pump-lang', 'en'));
	await page.setViewportSize({ width, height });
	await mock(page, crew);
	await signIn(page, pump.email);
	await page.getByTestId('reg-open-calendar').click();
	await expect(page.getByTestId('reg-calendar')).toBeVisible();
}

const sheet = (page: Page) => page.getByTestId('reg-sheet-body');
const cell = (page: Page, n: number) =>
	page.locator(`[data-testid="reg-cal-day"][data-day="2026-11-${String(n).padStart(2, '0')}"]`);

test.describe('phone, 390 px', () => {
	test.use({ hasTouch: true });

	test('every state in Hindi, with room to tap and no sideways scroll', async ({ page }) => {
		await open(page, 390, 844);
		await expect(sheet(page)).toHaveScreenshot('calendar-hindi.png');
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
		for (const box of await page.getByTestId('reg-cal-day').evaluateAll((els) =>
			els.map((el) => el.getBoundingClientRect()).map((r) => [r.width, r.height])
		)) {
			expect(box[0]).toBeGreaterThanOrEqual(48);
			expect(box[1]).toBeGreaterThanOrEqual(48);
		}
		const axe = await new AxeBuilder({ page }).include('[data-testid="reg-sheet"]').analyze();
		expect(axe.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
	});

	test('every state in English', async ({ page }) => {
		await open(page, 390, 844, true);
		await expect(sheet(page)).toHaveScreenshot('calendar-english.png');
	});

	for (const [n, name] of [
		[2, 'full'],
		[3, 'partial'],
		[4, 'missed'],
		[5, 'waiting'],
		[6, 'regularised'],
		[7, 'rejected'],
		[10, 'open']
	] as const) {
		test(`day panel: ${name}`, async ({ page }) => {
			await open(page, 390, 844, true);
			await cell(page, n).click();
			await expect(page.getByTestId('reg-cal-panel')).toBeVisible();
			await expect(sheet(page)).toHaveScreenshot(`panel-${name}.png`);
		});
	}

	test('the three steps on a half-counted day', async ({ page }) => {
		await open(page, 390, 844);
		await cell(page, 3).click();
		await page.getByTestId('reg-cal-apply').click();
		await expect(page.getByTestId('reg-reason-forgot')).toBeVisible();
		await expect(sheet(page)).toHaveScreenshot('step-why.png');
		await page.getByTestId('reg-reason-forgot').click();
		await page.getByTestId('reg-next').click();
		await expect(page.getByTestId('reg-face')).toHaveCount(3);
		await expect(sheet(page)).toHaveScreenshot('step-who-partial.png');
		await page.getByTestId('reg-next').click();
		await expect(page.getByTestId('reg-send')).toBeVisible();
		await expect(sheet(page)).toHaveScreenshot('step-check.png');
		await page.getByTestId('reg-send').click();
		await expect(page.getByTestId('reg-sent')).toBeVisible();
		await expect(sheet(page)).toHaveScreenshot('step-sent.png');
	});

	test('a crew of 27 stays inside the screen', async ({ page }) => {
		await open(page, 390, 844, false, CREW_27);
		await cell(page, 4).click();
		await page.getByTestId('reg-cal-apply').click();
		await page.getByTestId('reg-reason-forgot').click();
		await page.getByTestId('reg-next').click();
		await expect(page.getByTestId('reg-face')).toHaveCount(27);
		const box = await sheet(page).boundingBox();
		expect(box!.height).toBeLessThanOrEqual(844);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
		await expect(sheet(page)).toHaveScreenshot('step-who-27.png');
	});

	test('no worker with attendance yet', async ({ page }) => {
		await open(page, 390, 844, false, { kind: 'missed', crew: [] });
		await cell(page, 4).click();
		await page.getByTestId('reg-cal-apply').click();
		await page.getByTestId('reg-reason-forgot').click();
		await page.getByTestId('reg-next').click();
		await expect(page.getByTestId('reg-no-crew')).toBeVisible();
		await expect(sheet(page)).toHaveScreenshot('step-no-crew.png');
	});
});

test('desktop width keeps the calendar readable', async ({ page }) => {
	await open(page, 1280, 800, true);
	await expect(sheet(page)).toHaveScreenshot('calendar-desktop.png');
});
