import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const outputRoot = path.resolve(
	'test-output',
	'attendance-usability',
	process.env.USABILITY_OUTPUT_STAGE || 'final'
);

const accounts = {
	admin: {
		email: process.env.USABILITY_ADMIN_EMAIL || 'admin@attendance.local',
		password: process.env.USABILITY_ADMIN_PASSWORD || 'Admin1234!'
	},
	vendor: {
		email: process.env.USABILITY_VENDOR_EMAIL || 'rvnenterprises@vendors.local',
		password: process.env.USABILITY_VENDOR_PASSWORD || 'Test1234!'
	},
	pump: {
		email: process.env.USABILITY_PUMP_EMAIL || 'bglprvn1@pumps.local',
		password: process.env.USABILITY_PUMP_PASSWORD || 'Test1234!'
	}
} as const;

function runtimeMonitor(page: Page) {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(`console: ${message.text()}`);
	});
	page.on('requestfailed', (request) => {
		if (request.failure()?.errorText === 'net::ERR_ABORTED') return;
		errors.push(`request: ${request.method()} ${request.url()} ${request.failure()?.errorText}`);
	});
	page.on('response', (response) => {
		if (response.status() >= 500) errors.push(`response: ${response.status()} ${response.url()}`);
	});
	return errors;
}

async function login(page: Page, role: keyof typeof accounts) {
	await page.goto('/login');
	await page.getByTestId('login-email').fill(accounts[role].email);
	await page.getByTestId('login-password').fill(accounts[role].password);
	await page.getByTestId('login-submit').click();
	await expect(page).toHaveURL(new RegExp(`/${role === 'pump' ? 'pump' : role}(?:/)?$`));
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
	await expect(page.locator('body')).toBeVisible();
	await page.screenshot({
		path: path.join(outputRoot, `${testInfo.project.name}-${name}.png`),
		fullPage: true
	});
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
	expect(overflow, `${name} should not overflow horizontally`).toBeLessThanOrEqual(2);
}

test.beforeAll(async () => {
	await mkdir(outputRoot, { recursive: true });
});

test('admin can understand the overview, attendance records, and review queues', async ({ page }, testInfo) => {
	const errors = runtimeMonitor(page);
	await login(page, 'admin');
	await capture(page, testInfo, 'admin-overview');
	await expect(page.getByText('Fraud flags today', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Needs your attention' })).toBeVisible();

	for (const [route, name] of [
		['/admin/attendance', 'admin-attendance'],
		['/admin/insights', 'admin-insights'],
		['/admin/fraud-flags', 'admin-fraud-flags'],
		['/admin/flagged-guests', 'admin-guest-review'],
		['/admin/merge-candidates', 'admin-merge-review']
	] as const) {
		await page.goto(route);
		await capture(page, testInfo, name);
	}

	expect(errors).toEqual([]);
});

test('admin date view shows only the fields that affect the current result', async ({ page }, testInfo) => {
	await login(page, 'admin');
	await page.goto('/admin/attendance');
	await expect(page.getByRole('button', { name: 'Date range' })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByLabel('From')).toBeVisible();
	await expect(page.getByLabel('To', { exact: true })).toBeVisible();
	await expect(page.getByLabel('Day', { exact: true })).toHaveCount(0);

	await page.getByRole('button', { name: 'Single day' }).click();
	await expect(page.getByRole('button', { name: 'Single day' })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByLabel('Day', { exact: true })).toBeVisible();
	await expect(page.getByLabel('From')).toHaveCount(0);
	await expect(page.getByLabel('To', { exact: true })).toHaveCount(0);
	await capture(page, testInfo, 'admin-attendance-single-day');
});

test('vendor can find attendance, pumps, and people', async ({ page }, testInfo) => {
	const errors = runtimeMonitor(page);
	await login(page, 'vendor');
	await capture(page, testInfo, 'vendor-overview');

	for (const [route, name] of [
		['/vendor/attendance', 'vendor-attendance'],
		['/vendor/pumps', 'vendor-pumps'],
		['/vendor/people', 'vendor-people']
	] as const) {
		await page.goto(route);
		await capture(page, testInfo, name);
	}

	expect(errors).toEqual([]);
});

test('pump operator sees one clear attendance action', async ({ page }, testInfo) => {
	const errors = runtimeMonitor(page);
	await login(page, 'pump');
	await capture(page, testInfo, 'pump-attendance');
	expect(errors).toEqual([]);
});

test('mobile navigation opens without obscuring its controls', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'Mobile-only navigation check');
	await login(page, 'admin');
	const trigger = page.getByRole('button', { name: 'Open navigation' });
	await trigger.click();
	await expect(page.getByRole('navigation')).toBeVisible();
	await expect(
		page.getByRole('complementary', { name: 'admin navigation' }).getByLabel('Close navigation')
	).toBeFocused();
	await capture(page, testInfo, 'admin-navigation-open');
	await page.keyboard.press('Escape');
	await expect(trigger).toBeFocused();
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});
