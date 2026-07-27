import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const { Pool } = pg;
const pool = new Pool({
	connectionString:
		process.env.DATABASE_URL || 'postgres://attendance:attendance@localhost:5433/attendance'
});
const screenshots = path.resolve('test-output/ui-redesign');
const baseUrl = 'http://127.0.0.1:4177';

type Role = 'admin' | 'vendor' | 'pump';

async function authenticate(page: Page, role: Role) {
	const table = role === 'pump' ? 'pumps' : `${role}s`;
	const emailColumn = role === 'pump' ? 'login_email' : 'email';
	const result = await pool.query(
		`SELECT id, ${emailColumn} AS email FROM ${table} ORDER BY created_at LIMIT 1`
	);
	if (!result.rows[0]) throw new Error(`No ${role} account is available in the test database.`);

	const token = jwt.sign(
		{ role, id: result.rows[0].id, email: result.rows[0].email },
		process.env.JWT_SECRET || 'dev-secret-change-me',
		{ expiresIn: '1h' }
	);
	await page.context().addCookies([
		{
			name: 'session',
			value: token,
			url: baseUrl,
			httpOnly: true,
			sameSite: 'Lax'
		}
	]);
}

async function expectNoHorizontalOverflow(page: Page) {
	const dimensions = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth
	}));
	expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

test.beforeAll(async () => {
	await mkdir(screenshots, { recursive: true });
});

test.afterAll(async () => {
	await pool.end();
});

test('login is accessible and reflows on a narrow phone', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 720 });
	await page.goto('/login');
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
	await expect(page.getByTestId('login-submit')).toBeVisible();
	await expectNoHorizontalOverflow(page);

	const results = await new AxeBuilder({ page }).analyze();
	expect(results.violations).toEqual([]);
	await page.screenshot({ path: path.join(screenshots, 'login-320.png'), fullPage: true });
});

test('pump capture retains a selected group photo before submission', async ({ page }) => {
	await authenticate(page, 'pump');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/pump');
	await page.getByTestId('capture-input').setInputFiles('Test/faces/group photo.jpg');
	await expect(page.getByAltText('Selected group attendance preview')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Submit group photo' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: path.join(screenshots, 'pump-preview-390.png'), fullPage: true });
});

test('admin overview renders its operational shell without serious accessibility issues', async ({
	page
}) => {
	await authenticate(page, 'admin');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/admin');
	await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
	await expect(page.getByTestId('admin-metrics')).toBeVisible();
	await expectNoHorizontalOverflow(page);

	const results = await new AxeBuilder({ page }).analyze();
	expect(
		results.violations.filter(
			(violation) => violation.impact === 'serious' || violation.impact === 'critical'
		)
	).toEqual([]);
	await page.screenshot({
		path: path.join(screenshots, 'admin-overview-1440.png'),
		fullPage: true
	});
});

test('vendor navigation exposes all scoped work views', async ({ page }) => {
	await authenticate(page, 'vendor');
	await page.setViewportSize({ width: 768, height: 1024 });
	await page.goto('/vendor');
	await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Attendance', exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Pumps', exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: 'People', exact: true })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await page.screenshot({
		path: path.join(screenshots, 'vendor-overview-768.png'),
		fullPage: true
	});
});

test('admin and vendor operational routes render without server errors', async ({ page }) => {
	await authenticate(page, 'admin');
	const ids = await Promise.all([
		pool.query('SELECT id FROM pumps ORDER BY created_at LIMIT 1'),
		pool.query('SELECT id FROM vendors ORDER BY created_at LIMIT 1'),
		pool.query('SELECT id FROM areas ORDER BY created_at LIMIT 1'),
		pool.query('SELECT id FROM persons ORDER BY first_seen_at LIMIT 1')
	]);
	const adminRoutes = [
		'/admin/insights',
		'/admin/attendance',
		'/admin/fraud-flags',
		'/admin/flagged-guests',
		'/admin/merge-candidates',
		'/admin/import',
		`/admin/pumps/${ids[0].rows[0].id}`,
		`/admin/vendors/${ids[1].rows[0].id}`,
		`/admin/areas/${ids[2].rows[0].id}`,
		`/admin/persons/${ids[3].rows[0].id}`
	];

	for (const route of adminRoutes) {
		const response = await page.goto(route);
		expect(response?.status(), route).toBeLessThan(500);
		await expect(page.getByText('Internal Error')).toHaveCount(0);
	}

	await page.context().clearCookies();
	await authenticate(page, 'vendor');
	for (const route of ['/vendor/attendance', '/vendor/pumps', '/vendor/people']) {
		const response = await page.goto(route);
		expect(response?.status(), route).toBeLessThan(500);
		await expect(page.getByText('Internal Error')).toHaveCount(0);
	}
});
