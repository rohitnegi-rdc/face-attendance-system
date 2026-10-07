import { expect, test, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const { Pool } = pg;
const pool = new Pool({
	connectionString:
		process.env.DATABASE_URL || 'postgres://attendance:attendance@localhost:5433/attendance'
});
const baseUrl = process.env.AUDIT_BASE_URL || 'http://127.0.0.1:4179';
const outputDir = path.resolve('test-output/ui-audit');
const auditTag = `E2E-UIAUDIT-${Date.now()}`;
const auditPumpCode = `${auditTag}-P01`;
let auditPumpId = '';

type Role = 'admin' | 'vendor' | 'pump';

async function authenticate(page: Page, role: Role, accountId?: string) {
	const table = role === 'pump' ? 'pumps' : `${role}s`;
	const emailColumn = role === 'pump' ? 'login_email' : 'email';
	const result = accountId
		? await pool.query(`SELECT id, ${emailColumn} AS email FROM ${table} WHERE id = $1`, [
				accountId
			])
		: await pool.query(
				`SELECT id, ${emailColumn} AS email FROM ${table} ORDER BY created_at LIMIT 1`
			);
	if (!result.rows[0]) throw new Error(`No ${role} account is available.`);

	const token = jwt.sign(
		{ role, id: result.rows[0].id, email: result.rows[0].email },
		process.env.JWT_SECRET || 'dev-secret-change-me',
		{ expiresIn: '1h' }
	);
	await page
		.context()
		.addCookies([{ name: 'session', value: token, url: baseUrl, httpOnly: true, sameSite: 'Lax' }]);
}

function monitorRuntime(page: Page) {
	const failures: string[] = [];
	page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
	page.on('console', (message) => {
		if (message.type() === 'error') failures.push(`console: ${message.text()}`);
	});
	page.on('requestfailed', (request) => {
		if (request.failure()?.errorText === 'net::ERR_ABORTED') return;
		failures.push(
			`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText}`
		);
	});
	page.on('response', (response) => {
		if (response.status() >= 500) {
			failures.push(
				`response ${response.status()}: ${response.request().method()} ${response.url()}`
			);
		}
	});
	return failures;
}

async function expectHealthyPage(page: Page, url: string) {
	const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
	expect(response?.status(), url).toBeLessThan(500);
	await expect(page.getByText('Internal Error')).toHaveCount(0);
	await expect(page.locator('body')).not.toBeEmpty();
}

function personLabel(pumpCode: string, displaySeq: number) {
	return `${pumpCode} Worker ${displaySeq}`;
}

function statusLabel(row: { morning_matched: boolean; evening_matched: boolean }) {
	if (row.morning_matched && row.evening_matched) return 'Present';
	if (row.morning_matched) return 'Morning only';
	if (row.evening_matched) return 'Evening only';
	return 'Absent';
}

function embedding(...components: number[]) {
	return `[${[...components, ...Array(512 - components.length).fill(0)].join(',')}]`;
}

async function taggedPhoto(relativePath: string, marker: string) {
	const buffer = await readFile(path.resolve('tests/fixtures/group-e2e/photos', relativePath));
	return Buffer.concat([buffer, Buffer.from(`\nE2E-EVIDENCE:${marker}\n`)]);
}

async function createMergePair(pumpId: string, axis: number) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const current = await client.query(
			`SELECT COALESCE(MAX(display_seq), 0)::int AS max_seq
			 FROM persons WHERE pump_id = $1`,
			[pumpId]
		);
		const firstSeq = Number(current.rows[0].max_seq) + 1;
		const first = (
			await client.query(
				`INSERT INTO persons (pump_id, display_seq) VALUES ($1, $2) RETURNING id`,
				[pumpId, firstSeq]
			)
		).rows[0];
		const second = (
			await client.query(
				`INSERT INTO persons (pump_id, display_seq) VALUES ($1, $2) RETURNING id`,
				[pumpId, firstSeq + 1]
			)
		).rows[0];
		const firstVector = Array(512).fill(0);
		const secondVector = Array(512).fill(0);
		firstVector[axis] = 1;
		secondVector[axis] = 0.6;
		secondVector[axis + 1] = 0.8;
		await client.query(
			`INSERT INTO person_face_vectors (person_id, embedding)
			 VALUES ($1, $2::vector), ($3, $4::vector)`,
			[first.id, `[${firstVector.join(',')}]`, second.id, `[${secondVector.join(',')}]`]
		);
		await client.query('COMMIT');
		return {
			firstId: first.id as string,
			secondId: second.id as string,
			firstSeq,
			secondSeq: firstSeq + 1
		};
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
	await mkdir(outputDir, { recursive: true });
});

test.afterAll(async () => {
	await pool.end();
});

test('reported 28 July attendance stays on 28 July in pump drill-down', async ({ page }) => {
	await authenticate(page, 'admin');
	const failures = monitorRuntime(page);
	const target = (
		await pool.query(
			`SELECT dpa.session_date::text AS session_date, dpa.morning_matched,
			        dpa.evening_matched, p.display_seq, pu.id AS pump_id, pu.pump_code
			 FROM daily_person_attendance dpa
			 JOIN persons p ON p.id = dpa.person_id
			 JOIN pumps pu ON pu.id = dpa.pump_id
			 WHERE dpa.session_date = DATE '2026-07-28'
			   AND dpa.morning_matched
			   AND pu.pump_code LIKE 'E2E%'
			 ORDER BY dpa.evening_matched, pu.pump_code, p.display_seq
			 LIMIT 1`
		)
	).rows[0];
	expect(target, 'A retained 28 July E2E attendance row is required').toBeTruthy();

	await expectHealthyPage(
		page,
		`/admin/attendance?day=${target.session_date}&session=morning&status=present`
	);
	await page.getByRole('button', { name: `Expand ${target.pump_code}` }).click();
	await expect(
		page
			.locator('.person-records')
			.getByText(personLabel(target.pump_code, Number(target.display_seq)), { exact: true })
	).toBeVisible();

	await page.getByRole('link', { name: target.pump_code, exact: true }).first().click();
	await expect(page).toHaveURL(new RegExp(`/admin/pumps/${target.pump_id}`));
	const expected = `${personLabel(target.pump_code, Number(target.display_seq))}, Tue, 28 Jul 2026: ${statusLabel(target)}`;
	await expect(page.locator(`td[aria-label="${expected}"]`)).toBeVisible();
	await expect(
		page.locator(
			`td[aria-label="${personLabel(target.pump_code, Number(target.display_seq))}, Mon, 27 Jul 2026: ${statusLabel(target)}"]`
		)
	).toHaveCount(0);
	await page.screenshot({
		path: path.join(outputDir, 'date-cross-view-fixed.png'),
		fullPage: true
	});
	expect(failures).toEqual([]);
});

test('admin attendance categorical permutations and every filter option render without errors', async ({
	page
}) => {
	await authenticate(page, 'admin');
	const failures = monitorRuntime(page);
	const sessions = ['', 'morning', 'evening'];
	const statuses = ['', 'present', 'absent'];
	const pageSizes = ['25', '50', '100'];
	let checked = 0;

	for (const session of sessions) {
		for (const status of statuses) {
			for (const pageSize of pageSizes) {
				const query = new URLSearchParams({ page_size: pageSize });
				if (session) query.set('session', session);
				if (status) query.set('status', status);
				await expectHealthyPage(page, `/admin/attendance?${query}`);
				checked += 1;
			}
		}
	}

	const dimensions = [
		['area', `SELECT id::text AS value FROM areas ORDER BY name`],
		['vendor', `SELECT id::text AS value FROM vendors ORDER BY name`],
		['plant', `SELECT id::text AS value FROM plants ORDER BY name`],
		['pump', `SELECT id::text AS value FROM pumps ORDER BY pump_code`]
	] as const;
	for (const [name, sql] of dimensions) {
		const values = (await pool.query(sql)).rows;
		for (const { value } of values) {
			await expectHealthyPage(page, `/admin/attendance?${name}=${value}`);
			checked += 1;
		}
	}

	const hierarchyRows = (
		await pool.query(
			`SELECT a.id::text AS area, v.id::text AS vendor, pl.id::text AS plant,
			        pu.id::text AS pump
			 FROM pumps pu
			 JOIN vendors v ON v.id = pu.vendor_id
			 JOIN plants pl ON pl.id = pu.plant_id
			 JOIN areas a ON a.id = pl.area_id
			 WHERE pu.pump_code LIKE 'E2E%'
			 ORDER BY pu.pump_code`
		)
	).rows;
	for (const hierarchy of hierarchyRows) {
		const query = new URLSearchParams({ ...hierarchy, session: 'morning', status: 'present' });
		await expectHealthyPage(page, `/admin/attendance?${query}`);
		checked += 1;
	}

	for (const sort of ['session_date', 'pump_code', 'vendor_name', 'area_name', 'status']) {
		for (const dir of ['asc', 'desc']) {
			await expectHealthyPage(page, `/admin/attendance?sort=${sort}&dir=${dir}`);
			checked += 1;
		}
	}
	for (const query of [
		'day=2026-07-28',
		'from=2026-07-27&to=2026-07-28',
		'day=not-a-date',
		'day=2026-02-30',
		'from=invalid&to=invalid',
		'area=not-a-uuid&vendor=not-a-uuid&plant=not-a-uuid&pump=not-a-uuid',
		'page=not-a-number',
		'page=-3',
		'page_size=invalid'
	]) {
		await expectHealthyPage(page, `/admin/attendance?${query}`);
		checked += 1;
	}

	expect(checked).toBeGreaterThan(100);
	expect(failures).toEqual([]);
});

test('attendance controls work by clicking and exports preserve filter semantics', async ({
	page
}) => {
	await authenticate(page, 'admin');
	const failures = monitorRuntime(page);
	await expectHealthyPage(page, '/admin/attendance');

	await page.getByLabel('Session').selectOption('morning');
	await page.getByLabel('Status').selectOption('present');
	await page.getByLabel('Rows').selectOption('25');
	await Promise.all([
		page.waitForURL(/session=morning.*status=present.*page_size=25/),
		page.getByRole('button', { name: 'Apply' }).click()
	]);
	await expect(page.getByRole('heading', { name: 'Records', exact: true })).toBeVisible();
	await page.screenshot({
		path: path.join(outputDir, 'present-status-filter-fixed.png'),
		fullPage: true
	});

	for (const sortName of ['Date', 'Pump', 'Vendor', 'Area', 'Status']) {
		await page.getByRole('link', { name: sortName, exact: true }).click();
		await expect(page).toHaveURL(/sort=/);
		await page.waitForLoadState('networkidle');
		await page.getByRole('link', { name: sortName, exact: true }).click();
		await expect(page).toHaveURL(/dir=desc/);
		await page.waitForLoadState('networkidle');
	}
	const next = page.getByRole('link', { name: 'Next', exact: true });
	if (await next.isVisible()) {
		await next.click();
		await expect(page).toHaveURL(/page=2/);
		await page.waitForLoadState('networkidle');
		await page.getByRole('link', { name: 'Previous', exact: true }).click();
		await expect(page).toHaveURL(/page=1/);
		await page.waitForLoadState('networkidle');
	}

	const download = await page.request.get(
		'/api/admin/attendance/export?session=morning&status=present&day=2026-07-28'
	);
	expect(download.status()).toBe(200);
	expect(download.headers()['content-type']).toContain(
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
	);
	const exportBody = await download.body();
	expect(exportBody.byteLength).toBeGreaterThan(1000);
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(exportBody as any);
	const firstExportedDate = workbook.getWorksheet('Attendance')?.getCell('A2').value;
	expect(firstExportedDate).toBeInstanceOf(Date);
	expect((firstExportedDate as Date).toISOString().slice(0, 10)).toBe('2026-07-28');
	expect(workbook.getWorksheet('Attendance')?.getCell('I2').text).toBe('Present');

	await page.getByRole('link', { name: 'Clear', exact: true }).click();
	await expect(page).toHaveURL(/\/admin\/attendance$/);
	expect(failures).toEqual([]);
});

test('all retained E2E attendance rows agree with pump calendar date and status', async ({
	page
}) => {
	await authenticate(page, 'admin');
	const failures = monitorRuntime(page);
	const rows = (
		await pool.query(
			`SELECT dpa.session_date::text AS session_date, dpa.morning_matched,
			        dpa.evening_matched, p.display_seq, pu.id AS pump_id, pu.pump_code
			 FROM daily_person_attendance dpa
			 JOIN persons p ON p.id = dpa.person_id
			 JOIN pumps pu ON pu.id = dpa.pump_id
			 WHERE pu.pump_code LIKE 'E2E%'
			   AND dpa.session_date BETWEEN DATE '2026-07-27' AND DATE '2026-07-28'
			 ORDER BY pu.pump_code, dpa.session_date, p.display_seq`
		)
	).rows;
	expect(rows.length).toBeGreaterThan(0);

	const byPump = new Map<string, typeof rows>();
	for (const row of rows) {
		if (!byPump.has(row.pump_id)) byPump.set(row.pump_id, []);
		byPump.get(row.pump_id)!.push(row);
	}
	for (const [pumpId, pumpRows] of byPump) {
		await expectHealthyPage(page, `/admin/pumps/${pumpId}?from=2026-07-27&to=2026-07-28`);
		for (const row of pumpRows) {
			const formattedDate =
				row.session_date === '2026-07-28' ? 'Tue, 28 Jul 2026' : 'Mon, 27 Jul 2026';
			const label = `${personLabel(row.pump_code, Number(row.display_seq))}, ${formattedDate}: ${statusLabel(row)}`;
			await expect(page.locator(`td[aria-label="${label}"]`), label).toHaveCount(1);
		}
	}
	expect(failures).toEqual([]);
});

test('admin, vendor, and Area aggregate calendars agree for the same date', async ({ page }) => {
	await authenticate(page, 'admin');
	const failures = monitorRuntime(page);
	const targetVendor = (
		await pool.query(
			`SELECT v.id, COUNT(*) AS attendance_rows
			 FROM daily_person_attendance dpa
			 JOIN pumps pu ON pu.id = dpa.pump_id
			 JOIN vendors v ON v.id = pu.vendor_id
			 WHERE dpa.session_date = DATE '2026-07-28' AND pu.pump_code LIKE 'E2E%'
			 GROUP BY v.id ORDER BY COUNT(*) DESC LIMIT 1`
		)
	).rows[0];
	expect(targetVendor).toBeTruthy();
	const pumpTotals = (
		await pool.query(
			`SELECT pu.id, pu.pump_code, pu.plant_id, pl.area_id,
			        COUNT(*) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched)::int AS present,
			        COUNT(*)::int AS total
			 FROM daily_person_attendance dpa
			 JOIN pumps pu ON pu.id = dpa.pump_id
			 JOIN plants pl ON pl.id = pu.plant_id
			 WHERE dpa.session_date = DATE '2026-07-28' AND pu.vendor_id = $1
			 GROUP BY pu.id, pl.area_id ORDER BY pu.pump_code`,
			[targetVendor.id]
		)
	).rows;
	expect(pumpTotals.length).toBeGreaterThan(0);

	await expectHealthyPage(page, `/admin/attendance?day=2026-07-28&vendor=${targetVendor.id}`);
	for (const total of pumpTotals) {
		const row = page
			.locator('.pump-summary tbody > tr')
			.filter({ has: page.getByRole('link', { name: total.pump_code, exact: true }) });
		await expect(row.locator('td').nth(2)).toHaveText(String(total.present));
		await expect(row.locator('td').nth(3)).toHaveText(String(total.total - total.present));
		await expect(row.locator('td').nth(4)).toHaveText(String(total.total));
	}
	await page.screenshot({
		path: path.join(outputDir, 'cross-view-aggregate-consistency.png'),
		fullPage: true
	});

	await expectHealthyPage(page, `/admin/vendors/${targetVendor.id}?from=2026-07-28&to=2026-07-28`);
	for (const total of pumpTotals) {
		const pct = Math.round((total.present / total.total) * 100);
		await expect(
			page.locator(`td[aria-label="${total.pump_code}, Tue, 28 Jul 2026: ${pct}% attendance"]`)
		).toHaveCount(1);
	}

	const targetArea = pumpTotals[0].area_id;
	const plantTotals = (
		await pool.query(
			`SELECT pl.id, pl.name,
			        COUNT(*) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched)::int AS present,
			        COUNT(*)::int AS total
			 FROM daily_person_attendance dpa
			 JOIN pumps pu ON pu.id = dpa.pump_id
			 JOIN plants pl ON pl.id = pu.plant_id
			 WHERE dpa.session_date = DATE '2026-07-28' AND pl.area_id = $1
			 GROUP BY pl.id ORDER BY pl.name`,
			[targetArea]
		)
	).rows;
	await expectHealthyPage(page, `/admin/areas/${targetArea}?from=2026-07-28&to=2026-07-28`);
	for (const total of plantTotals) {
		const pct = Math.round((total.present / total.total) * 100);
		await expect(
			page.locator(`td[aria-label="${total.name}, Tue, 28 Jul 2026: ${pct}% attendance"]`)
		).toHaveCount(1);
	}

	await page.context().clearCookies();
	await authenticate(page, 'vendor', targetVendor.id);
	await expectHealthyPage(page, '/vendor/attendance?from=2026-07-28&to=2026-07-28');
	for (const total of pumpTotals) {
		const pct = Math.round((total.present / total.total) * 100);
		await expect(
			page.locator(`td[aria-label="${total.pump_code}, Tue, 28 Jul 2026: ${pct}% attendance"]`)
		).toHaveCount(1);
	}
	expect(failures).toEqual([]);
});

test('admin navigation, drill-down links, date presets, and vendor sorting are clickable', async ({
	page
}) => {
	await authenticate(page, 'admin');
	const failures = monitorRuntime(page);
	const ids = (
		await pool.query(
			`SELECT
			   (SELECT id::text FROM pumps ORDER BY created_at LIMIT 1) AS pump,
			   (SELECT id::text FROM vendors ORDER BY created_at LIMIT 1) AS vendor,
			   (SELECT id::text FROM areas ORDER BY created_at LIMIT 1) AS area,
			   (SELECT id::text FROM persons ORDER BY first_seen_at LIMIT 1) AS person`
		)
	).rows[0];
	const routes = [
		'/admin',
		'/admin/insights',
		'/admin/attendance',
		'/admin/fraud-flags',
		'/admin/flagged-guests',
		'/admin/merge-candidates',
		'/admin/import',
		`/admin/pumps/${ids.pump}`,
		`/admin/vendors/${ids.vendor}`,
		`/admin/areas/${ids.area}`,
		`/admin/persons/${ids.person}`
	];
	for (const route of routes) await expectHealthyPage(page, route);

	await expectHealthyPage(page, '/admin');
	for (const [name, destination] of [
		['Insights', '/admin/insights'],
		['Attendance', '/admin/attendance'],
		['Fraud flags', '/admin/fraud-flags'],
		['Guest review', '/admin/flagged-guests'],
		['Merge review', '/admin/merge-candidates'],
		['Imports', '/admin/import'],
		['Overview', '/admin']
	] as const) {
		await page.getByRole('link', { name, exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`${destination.replaceAll('/', '\\/')}$`));
		await page.waitForLoadState('networkidle');
	}

	for (const route of [
		`/admin/pumps/${ids.pump}`,
		`/admin/vendors/${ids.vendor}`,
		`/admin/areas/${ids.area}`
	]) {
		await expectHealthyPage(page, route);
		for (const preset of ['Today', 'Last 7 days', 'Last 30 days', 'This month']) {
			await page.getByRole('button', { name: preset, exact: true }).click();
			await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
			await page.waitForLoadState('networkidle');
		}
		await page.getByLabel('From').fill('2026-07-27');
		await page.getByLabel('To').fill('2026-07-28');
		await page.getByLabel('To').press('Tab');
		await expect(page).toHaveURL(/from=2026-07-27&to=2026-07-28/);
	}

	await expectHealthyPage(page, `/admin/vendors/${ids.vendor}`);
	await page.getByRole('button', { name: /Pump/ }).click();
	await page.getByRole('button', { name: /Attendance/ }).click();

	await page.setViewportSize({ width: 390, height: 844 });
	await expectHealthyPage(page, '/admin');
	await page.getByRole('button', { name: 'Open navigation' }).click();
	const drawer = page.locator('aside[aria-label="admin navigation"]');
	await expect(drawer).toHaveClass(/open/);
	await drawer.getByRole('button', { name: 'Close navigation' }).click();
	await expect(drawer).not.toHaveClass(/open/);
	expect(failures).toEqual([]);
});

test('vendor filters, navigation, and every scoped option work in the browser', async ({
	page
}) => {
	const vendor = (
		await pool.query(
			`SELECT v.id, v.name, pu.id AS pump_id, pu.pump_code, p.id AS person_id
			 FROM vendors v
			 JOIN pumps pu ON pu.vendor_id = v.id
			 JOIN persons p ON p.pump_id = pu.id AND p.status = 'active'
			 WHERE pu.pump_code LIKE 'E2E%'
			 ORDER BY v.created_at, pu.created_at, p.display_seq LIMIT 1`
		)
	).rows[0];
	await pool.query(
		`INSERT INTO daily_person_attendance
		   (person_id, pump_id, session_date, morning_matched, evening_matched)
		 VALUES ($1, $2, DATE '2025-12-31', true, true)
		 ON CONFLICT (person_id, session_date) DO UPDATE SET
		   morning_matched = true, evening_matched = true`,
		[vendor.person_id, vendor.pump_id]
	);
	await authenticate(page, 'vendor', vendor.id);
	const failures = monitorRuntime(page);

	for (const route of ['/vendor', '/vendor/attendance', '/vendor/pumps', '/vendor/people']) {
		await expectHealthyPage(page, route);
	}
	await expectHealthyPage(page, '/vendor');
	for (const [name, destination] of [
		['Attendance', '/vendor/attendance'],
		['Pumps', '/vendor/pumps'],
		['People', '/vendor/people'],
		['Overview', '/vendor']
	] as const) {
		await page.getByRole('link', { name, exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`${destination.replaceAll('/', '\\/')}$`));
		await page.waitForLoadState('networkidle');
	}
	await expectHealthyPage(
		page,
		'/vendor/attendance?from=2026-02-30&to=invalid&area=bad&plant=bad&pump=bad'
	);
	await expectHealthyPage(page, '/vendor/people?pump=not-a-uuid');
	await expectHealthyPage(page, '/vendor/attendance?from=2025-12-31&to=2025-12-31');
	await expect(
		page.locator(`td[aria-label="${vendor.pump_code}, Wed, 31 Dec 2025: 100% attendance"]`)
	).toBeVisible();
	await page.screenshot({
		path: path.join(outputDir, 'vendor-historical-date-fixed.png'),
		fullPage: true
	});

	await expectHealthyPage(page, '/vendor/attendance');
	for (const label of ['Area', 'Plant', 'Pump']) {
		const select = page.getByLabel(label);
		const values = await select
			.locator('option')
			.evaluateAll((options) =>
				options.map((option) => (option as HTMLOptionElement).value).filter(Boolean)
			);
		for (const value of values) {
			await expectHealthyPage(page, `/vendor/attendance?${label.toLowerCase()}=${value}`);
		}
	}
	await page.getByLabel('From').fill('2026-07-27');
	await page.getByLabel('To').fill('2026-07-28');
	await Promise.all([
		page.waitForURL(/from=2026-07-27.*to=2026-07-28/),
		page.getByRole('button', { name: 'Apply' }).click()
	]);

	await expectHealthyPage(page, '/vendor/people');
	const pumpValues = await page
		.getByLabel('Pump')
		.locator('option')
		.evaluateAll((options) =>
			options.map((option) => (option as HTMLOptionElement).value).filter(Boolean)
		);
	for (const pump of pumpValues) {
		await expectHealthyPage(page, `/vendor/people?pump=${pump}`);
	}
	expect(failures).toEqual([]);
});

test('login visibility, invalid credentials, valid login, and sign out buttons work', async ({
	page
}) => {
	const failures = monitorRuntime(page);
	const admin = (await pool.query('SELECT email FROM admins ORDER BY created_at LIMIT 1')).rows[0];
	await expectHealthyPage(page, '/login');

	await page.getByLabel('Email address').fill(admin.email);
	const password = page.getByTestId('login-password');
	await password.fill('incorrect-password');
	await page.getByRole('button', { name: 'Show password' }).click();
	await expect(password).toHaveAttribute('type', 'text');
	await page.getByRole('button', { name: 'Hide password' }).click();
	await expect(password).toHaveAttribute('type', 'password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('alert')).toContainText('Invalid credentials');
	failures.length = 0;

	await password.fill('Admin1234!');
	await Promise.all([
		page.waitForURL(/\/admin$/),
		page.getByRole('button', { name: 'Sign in' }).click()
	]);
	await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login$/);
	await expectHealthyPage(page, '/admin');
	await expect(page).toHaveURL(/\/login$/);
	expect(failures).toEqual([]);
});

test('CSV template, validation, removal, and valid import controls work', async ({ page }) => {
	await authenticate(page, 'admin');
	const failures = monitorRuntime(page);
	await expectHealthyPage(page, '/admin/import');

	const template = await page.request.get('/import-template.csv');
	expect(template.status()).toBe(200);
	expect((await template.text()).split(/\r?\n/, 1)[0]).toBe(
		'Area Name,Plant Name,PUMP Name,Vendor Name'
	);

	const fileInput = page.getByTestId('csv-file-input');
	await fileInput.setInputFiles({
		name: 'invalid.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('not csv')
	});
	await expect(page.getByRole('alert')).toContainText('Choose a file with a .csv extension.');
	await expect(page.getByTestId('csv-import-submit')).toBeDisabled();

	await fileInput.setInputFiles({
		name: 'missing-headers.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('Area Name,Plant Name\nArea,Plant')
	});
	await expect(page.getByRole('alert')).toContainText('Missing required headers');

	const csv = [
		'Area Name,Plant Name,PUMP Name,Vendor Name',
		`${auditTag} Area,${auditTag} Plant,${auditPumpCode},${auditTag} Vendor`
	].join('\n');
	await fileInput.setInputFiles({
		name: `${auditTag}.csv`,
		mimeType: 'text/csv',
		buffer: Buffer.from(csv)
	});
	await expect(page.getByText(`${auditTag}.csv`, { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Remove selected CSV' }).click();
	await expect(page.getByTestId('csv-import-submit')).toBeDisabled();

	await fileInput.setInputFiles({
		name: `${auditTag}.csv`,
		mimeType: 'text/csv',
		buffer: Buffer.from(csv)
	});
	await page.getByTestId('csv-import-submit').click();
	await expect(page.getByTestId('import-summary')).toContainText('Import complete');
	const pump = (await pool.query('SELECT id FROM pumps WHERE pump_code = $1', [auditPumpCode]))
		.rows[0];
	expect(pump).toBeTruthy();
	auditPumpId = pump.id;
	await page.screenshot({ path: path.join(outputDir, 'csv-import-complete.png'), fullPage: true });
	expect(failures).toEqual([]);
});

test('guest dismiss/create-person and fraud review buttons update only audit fixtures', async ({
	page
}) => {
	expect(auditPumpId, 'CSV audit pump must be created first').toBeTruthy();
	await authenticate(page, 'admin');
	const failures = monitorRuntime(page);
	const session = (
		await pool.query(
			`INSERT INTO attendance_sessions
			   (pump_id, session_date, session_type, status, pairing_status, photo_hash, processed_at)
			 VALUES ($1, DATE '2026-07-26', 'morning', 'completed', 'open', $2, now())
			 ON CONFLICT (pump_id, session_date, session_type) DO UPDATE SET status = 'completed'
			 RETURNING id`,
			[auditPumpId, `${auditTag}-morning-hash`]
		)
	).rows[0];
	const dismissedGuest = (
		await pool.query(
			`INSERT INTO flagged_guests (session_id, embedding)
			 VALUES ($1, $2::vector) RETURNING id`,
			[session.id, embedding(1)]
		)
	).rows[0];
	const promotedGuest = (
		await pool.query(
			`INSERT INTO flagged_guests (session_id, embedding)
			 VALUES ($1, $2::vector) RETURNING id`,
			[session.id, embedding(0, 1)]
		)
	).rows[0];

	await expectHealthyPage(page, '/admin/flagged-guests');
	const cards = page.locator('.guest-card').filter({ hasText: auditPumpCode });
	await expect(cards).toHaveCount(2);
	await cards
		.filter({ has: page.locator(`input[value="${dismissedGuest.id}"]`) })
		.getByRole('button', { name: 'Dismiss guest' })
		.click();
	expect(
		(await pool.query('SELECT reviewed FROM flagged_guests WHERE id = $1', [dismissedGuest.id]))
			.rows[0].reviewed
	).toBe(true);

	const beforePeople = Number(
		(await pool.query('SELECT COUNT(*) AS count FROM persons WHERE pump_id = $1', [auditPumpId]))
			.rows[0].count
	);
	await page
		.locator('.guest-card')
		.filter({ has: page.locator(`input[value="${promotedGuest.id}"]`) })
		.getByRole('button', { name: 'Create person' })
		.click();
	const afterPeople = Number(
		(await pool.query('SELECT COUNT(*) AS count FROM persons WHERE pump_id = $1', [auditPumpId]))
			.rows[0].count
	);
	expect(afterPeople).toBe(beforePeople + 1);

	const secondPump = (
		await pool.query(
			`INSERT INTO pumps (plant_id, vendor_id, pump_code, login_email, password_hash)
			 SELECT plant_id, vendor_id, $2, $3, password_hash FROM pumps WHERE id = $1
			 RETURNING id`,
			[auditPumpId, `${auditTag}-P02`, `${auditTag.toLowerCase()}-p02@pumps.local`]
		)
	).rows[0];
	const secondSession = (
		await pool.query(
			`INSERT INTO attendance_sessions
			   (pump_id, session_date, session_type, status, pairing_status, photo_hash, processed_at)
			 VALUES ($1, DATE '2026-07-26', 'morning', 'completed', 'open', $2, now())
			 RETURNING id`,
			[secondPump.id, `${auditTag}-second-hash`]
		)
	).rows[0];
	const person = (
		await pool.query(
			`SELECT id FROM persons WHERE pump_id = $1 ORDER BY display_seq DESC LIMIT 1`,
			[auditPumpId]
		)
	).rows[0];
	const fraud = (
		await pool.query(
			`INSERT INTO fraud_flags
			   (session_id, person_id, matched_at_pump_id, matched_session_id, similarity_score)
			 VALUES ($1, $2, $3, $4, 0.91) RETURNING id`,
			[secondSession.id, person.id, auditPumpId, session.id]
		)
	).rows[0];

	await expectHealthyPage(page, '/admin/fraud-flags');
	const fraudArticle = page
		.locator('.review-item')
		.filter({ has: page.locator(`input[value="${fraud.id}"]`) });
	await expect(fraudArticle).toContainText(`${auditTag}-P02`);
	await fraudArticle.getByRole('button', { name: 'Mark reviewed' }).click();
	expect(
		(await pool.query('SELECT reviewed FROM fraud_flags WHERE id = $1', [fraud.id])).rows[0]
			.reviewed
	).toBe(true);
	expect(failures).toEqual([]);
});

test('merge dismiss and merge confirmation buttons persist correct decisions', async ({ page }) => {
	expect(auditPumpId, 'CSV audit pump must be created first').toBeTruthy();
	await authenticate(page, 'admin');
	const failures = monitorRuntime(page);

	const dismissPair = await createMergePair(auditPumpId, 4);
	await expectHealthyPage(page, '/admin/merge-candidates');
	const dismissCard = page
		.locator('.review-item')
		.filter({ hasText: personLabel(auditPumpCode, dismissPair.firstSeq) })
		.filter({ hasText: personLabel(auditPumpCode, dismissPair.secondSeq) });
	await expect(dismissCard).toBeVisible();
	await dismissCard.getByRole('button', { name: 'Dismiss suggestion' }).click();
	await expect(page.getByRole('status')).toContainText('Suggestion dismissed.');
	expect(
		(
			await pool.query(
				`SELECT decision FROM merge_review_decisions
				 WHERE lower_person_id = LEAST($1::uuid, $2::uuid)
				   AND higher_person_id = GREATEST($1::uuid, $2::uuid)`,
				[dismissPair.firstId, dismissPair.secondId]
			)
		).rows[0].decision
	).toBe('dismissed');

	const mergePair = await createMergePair(auditPumpId, 8);
	await expectHealthyPage(page, '/admin/merge-candidates');
	const mergeCard = page
		.locator('.review-item')
		.filter({ hasText: personLabel(auditPumpCode, mergePair.firstSeq) })
		.filter({ hasText: personLabel(auditPumpCode, mergePair.secondSeq) });
	await expect(mergeCard).toBeVisible();
	const keptId = await mergeCard.locator('input[name="kept"]').inputValue();
	const mergedId = await mergeCard.locator('input[name="merged"]').inputValue();
	await mergeCard.getByRole('button', { name: 'Merge people' }).click();
	await expect(page.getByRole('status')).toContainText('People merged.');
	const merged = (
		await pool.query('SELECT status, merged_into_person_id FROM persons WHERE id = $1', [mergedId])
	).rows[0];
	expect(merged.status).toBe('merged');
	expect(merged.merged_into_person_id).toBe(keptId);
	expect(failures).toEqual([]);
});

test('pump choose-photo, cancel, and sign-out controls work for the imported audit pump', async ({
	page
}) => {
	expect(auditPumpId, 'CSV audit pump must be created first').toBeTruthy();
	await pool.query(
		`UPDATE attendance_sessions
		 SET pairing_status = 'expired', submitted_at = now() - interval '25 hours'
		 WHERE pump_id = $1 AND pairing_status = 'open'`,
		[auditPumpId]
	);
	await authenticate(page, 'pump', auditPumpId);
	const failures = monitorRuntime(page);
	await expectHealthyPage(page, '/pump');

	await expect(page.getByRole('button', { name: 'Choose photo' })).toBeEnabled();
	const chooserPromise = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: 'Choose photo' }).click();
	const chooser = await chooserPromise;
	await chooser.setFiles('tests/fixtures/group-e2e/photos/a-01-baseline.jpg');
	await expect(page.getByAltText('Selected group attendance preview')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Submit group photo' })).toBeVisible();
	await page.getByRole('button', { name: 'Cancel' }).click();
	await expect(page.getByAltText('Selected group attendance preview')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Choose photo' })).toBeVisible();

	const cameraChooserPromise = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: 'Take photo' }).click();
	const cameraChooser = await cameraChooserPromise;
	await cameraChooser.setFiles('tests/fixtures/group-e2e/photos/a-02-lowlight.jpg');
	await expect(page.getByAltText('Selected group attendance preview')).toBeVisible();
	await page.route('**/api/attendance/submit', async (route) => {
		await route.fulfill({
			status: 409,
			contentType: 'application/json',
			body: JSON.stringify({ error: 'Audit rejection' })
		});
	});
	let submissionAttempts = 0;
	page.on('request', (request) => {
		if (request.url().includes('/api/attendance/submit')) submissionAttempts += 1;
	});
	expect(failures).toEqual([]);
	await page.getByRole('button', { name: 'Submit group photo' }).click();
	await expect(page.getByTestId('status-failed')).toContainText('Audit rejection');
	failures.length = 0;
	await page.getByRole('button', { name: 'Retry' }).click();
	await expect.poll(() => submissionAttempts).toBe(2);
	failures.length = 0;
	await page.getByRole('button', { name: 'Choose another' }).click();
	await expect(page.getByAltText('Selected group attendance preview')).toHaveCount(0);

	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login$/);
	expect(failures).toEqual([]);
});

test('attendance evidence shows live morning-only totals, both sessions, and persists flags', async ({
	page
}) => {
	const tag = `E2E-EVIDENCE-${Date.now()}`;
	const client = await pool.connect();
	let pumpId = '';
	try {
		await client.query('BEGIN');
		const area = (
			await client.query(`INSERT INTO areas (name) VALUES ($1) RETURNING id`, [`${tag} Area`])
		).rows[0];
		const plant = (
			await client.query(`INSERT INTO plants (area_id, name) VALUES ($1, $2) RETURNING id`, [
				area.id,
				`${tag} Plant`
			])
		).rows[0];
		const vendor = (
			await client.query(
				`INSERT INTO vendors (name, email, password_hash)
				 VALUES ($1, $2, 'unused') RETURNING id`,
				[`${tag} Vendor`, `${tag.toLowerCase()}@vendor.local`]
			)
		).rows[0];
		const pump = (
			await client.query(
				`INSERT INTO pumps (plant_id, vendor_id, pump_code, login_email, password_hash)
				 VALUES ($1, $2, $3, $4, 'unused') RETURNING id`,
				[plant.id, vendor.id, tag, `${tag.toLowerCase()}@pump.local`]
			)
		).rows[0];
		pumpId = pump.id;
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}

	const failures = monitorRuntime(page);
	await authenticate(page, 'pump', pumpId);
	await expectHealthyPage(page, '/pump');
	await page.getByTestId('capture-input').setInputFiles({
		name: 'morning-baseline.jpg',
		mimeType: 'image/jpeg',
		buffer: await taggedPhoto('a-01-baseline.jpg', `${tag}-morning`)
	});
	await page.getByRole('button', { name: 'Submit group photo' }).click();
	await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 4 * 60 * 1000 });

	const morning = (
		await pool.query(
			`SELECT s.id, dpa.person_id, p.display_seq
			 FROM attendance_sessions s
			 JOIN daily_person_attendance dpa
			   ON dpa.pump_id = s.pump_id AND dpa.session_date = s.session_date
			 JOIN persons p ON p.id = dpa.person_id
			 WHERE s.pump_id = $1 AND s.session_type = 'morning'
			 ORDER BY p.display_seq LIMIT 1`,
			[pumpId]
		)
	).rows[0];
	expect(morning).toBeTruthy();

	await authenticate(page, 'admin');
	await expectHealthyPage(page, `/admin/pumps/${pumpId}`);
	await expect(page.getByText(/1 morning-only session\b/)).toBeVisible();
	const rosterRow = page.locator('.data-table tbody tr').filter({
		hasText: `${tag} Worker ${morning.display_seq}`
	});
	await expect(rosterRow.locator('td').nth(4)).toHaveText('1');

	const morningEvidence = page.locator(
		`[data-testid="evidence-actions"][data-session-id="${morning.id}"]`
	);
	await morningEvidence.getByRole('button', { name: 'View group' }).click();
	await expect(page.locator('.evidence-dialog')).toBeVisible();
	await expect
		.poll(() =>
			page.locator('.evidence-dialog img').evaluate((image: HTMLImageElement) => image.naturalWidth)
		)
		.toBeGreaterThan(0);
	await page.getByTitle('Close evidence viewer').click();

	await morningEvidence.getByRole('button', { name: `View Worker ${morning.display_seq}` }).click();
	await expect(page.locator('.evidence-dialog')).toBeVisible();
	await expect
		.poll(() =>
			page.locator('.evidence-dialog img').evaluate((image: HTMLImageElement) => image.naturalWidth)
		)
		.toBeGreaterThan(0);
	await page.locator('.evidence-dialog select[name="reason"]').selectOption('incorrect_match');
	await page.locator('.evidence-dialog textarea[name="note"]').fill('Browser evidence audit');
	await page.getByRole('button', { name: 'Flag error' }).click();
	await expect(page.getByRole('status')).toContainText('flagged for review');
	expect(
		(
			await pool.query(
				`SELECT COUNT(*)::int AS count FROM attendance_review_flags
				 WHERE session_id = $1 AND person_id = $2 AND status = 'open'`,
				[morning.id, morning.person_id]
			)
		).rows[0].count
	).toBe(1);

	await expectHealthyPage(page, `/admin/persons/${morning.person_id}`);
	const morningMetric = page.locator('.metric').filter({
		has: page.getByText('Morning only', { exact: true })
	});
	await expect(morningMetric.locator('.metric__value')).toHaveText('1');
	await expect(
		page.locator(`[data-testid="evidence-actions"][data-session-id="${morning.id}"]`)
	).toContainText('View group');
	await page.screenshot({
		path: path.join(outputDir, 'person-morning-evidence.png'),
		fullPage: true
	});

	await pool.query(
		`UPDATE attendance_sessions SET submitted_at = submitted_at - interval '10 hours'
		 WHERE id = $1`,
		[morning.id]
	);
	await authenticate(page, 'pump', pumpId);
	await expectHealthyPage(page, '/pump');
	await page.getByTestId('capture-input').setInputFiles({
		name: 'evening-mirrored.jpg',
		mimeType: 'image/jpeg',
		buffer: await taggedPhoto('a-05-mirrored.jpg', `${tag}-evening`)
	});
	await page.getByRole('button', { name: 'Submit group photo' }).click();
	await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 4 * 60 * 1000 });

	const paired = (
		await pool.query(
			`SELECT dpa.person_id, morning.id AS morning_id, evening.id AS evening_id
			 FROM daily_person_attendance dpa
			 JOIN attendance_sessions morning
			   ON morning.pump_id = dpa.pump_id AND morning.session_date = dpa.session_date
			  AND morning.session_type = 'morning'
			 JOIN attendance_sessions evening
			   ON evening.pump_id = dpa.pump_id AND evening.session_date = dpa.session_date
			  AND evening.session_type = 'evening'
			 WHERE dpa.pump_id = $1 AND dpa.morning_matched AND dpa.evening_matched
			 ORDER BY dpa.person_id LIMIT 1`,
			[pumpId]
		)
	).rows[0];
	expect(paired, 'At least one worker must have morning and evening evidence').toBeTruthy();

	await authenticate(page, 'admin');
	await expectHealthyPage(page, `/admin/persons/${paired.person_id}`);
	const personEvidence = page.locator('[data-testid="evidence-actions"]');
	await expect(personEvidence).toHaveCount(2);
	await expect(
		personEvidence.filter({ has: page.getByRole('button', { name: 'View group' }) })
	).toHaveCount(2);
	await expect(
		personEvidence.filter({ has: page.getByRole('button', { name: 'View Individual photo' }) })
	).toHaveCount(2);

	for (const sessionId of [paired.morning_id, paired.evening_id]) {
		const evidence = page.locator(
			`[data-testid="evidence-actions"][data-session-id="${sessionId}"]`
		);
		await evidence.getByRole('button', { name: 'View group' }).click();
		await expect
			.poll(() =>
				page
					.locator('.evidence-dialog img')
					.evaluate((image: HTMLImageElement) => image.naturalWidth)
			)
			.toBeGreaterThan(0);
		await page.getByTitle('Close evidence viewer').click();
		await evidence.getByRole('button', { name: 'View Individual photo' }).click();
		await expect
			.poll(() =>
				page
					.locator('.evidence-dialog img')
					.evaluate((image: HTMLImageElement) => image.naturalWidth)
			)
			.toBeGreaterThan(0);
		await page.getByTitle('Close evidence viewer').click();
	}
	const eveningEvidence = page.locator(
		`[data-testid="evidence-actions"][data-session-id="${paired.evening_id}"]`
	);
	await eveningEvidence.getByRole('button', { name: 'View group' }).click();
	await page.locator('.evidence-dialog select[name="reason"]').selectOption('poor_photo');
	await page.getByRole('button', { name: 'Flag error' }).click();
	await expect(page.getByRole('status')).toContainText('flagged for review');
	expect(
		(
			await pool.query(
				`SELECT COUNT(*)::int AS count FROM attendance_review_flags
				 WHERE session_id = $1 AND person_id IS NULL AND status = 'open'`,
				[paired.evening_id]
			)
		).rows[0].count
	).toBe(1);
	await page.screenshot({
		path: path.join(outputDir, 'person-morning-evening-evidence.png'),
		fullPage: true
	});
	expect(failures).toEqual([]);
});
