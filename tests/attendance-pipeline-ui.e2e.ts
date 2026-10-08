import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
	connectionString:
		process.env.DATABASE_URL || 'postgres://attendance:attendance@127.0.0.1:5433/attendance'
});
const baseUrl = process.env.ATTENDANCE_E2E_BASE_URL || 'http://localhost:3000';
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
const fixtureRoot = path.resolve('tests/fixtures/group-e2e');
let screenshotRoot: string;
let runTag: string;

type Pump = { id: string; pump_code: string; login_email: string };
let pumps: Pump[] = [];

function cookieFor(pump: Pump) {
	return jwt.sign({ role: 'pump', id: pump.id, email: pump.login_email }, jwtSecret, {
		expiresIn: '4h'
	});
}

async function authenticate(page: Page, pump: Pump) {
	await page.context().addCookies([
		{
			name: 'session',
			value: cookieFor(pump),
			url: baseUrl,
			httpOnly: true,
			sameSite: 'Lax'
		}
	]);
}

async function createPump(plantId: string, vendorId: string, tag: string): Promise<Pump> {
	const result = await pool.query<Pump>(
		`INSERT INTO pumps (plant_id, vendor_id, pump_code, login_email, password_hash)
		 VALUES ($1, $2, $3, $4, 'e2e-unused')
		 RETURNING id, pump_code, login_email`,
		[plantId, vendorId, `E2EUI${tag}`, `e2e-ui-${tag.toLowerCase()}@e2e.local`]
	);
	return result.rows[0];
}

async function setupHierarchy() {
	runTag = new Date().toISOString().replace(/\D/g, '').slice(6, 14);
	const area = await pool.query<{ id: string }>(
		`INSERT INTO areas (name) VALUES ($1) RETURNING id`,
		[`E2E UI Area ${runTag}`]
	);
	const plant = await pool.query<{ id: string }>(
		`INSERT INTO plants (area_id, name) VALUES ($1, $2) RETURNING id`,
		[area.rows[0].id, `E2E UI Plant ${runTag}`]
	);
	const vendor = await pool.query<{ id: string }>(
		`INSERT INTO vendors (name, email, password_hash)
		 VALUES ($1, $2, 'e2e-unused') RETURNING id`,
		[`E2E UI Vendor ${runTag}`, `e2e-ui-vendor-${runTag}@e2e.local`]
	);
	pumps = await Promise.all(
		['FLOW', 'PAIR', 'EXPIRE', 'EMPTY', 'FAIL', 'LARGE'].map((suffix) =>
			createPump(plant.rows[0].id, vendor.rows[0].id, `${runTag}${suffix}`)
		)
	);
}

async function taggedFixture(relativePhoto: string, marker: string) {
	const buffer = await fs.readFile(path.join(fixtureRoot, relativePhoto));
	return Buffer.concat([buffer, Buffer.from(`\nE2E-UI:${runTag}:${marker}\n`)]);
}

async function submitApi(
	request: APIRequestContext,
	pump: Pump,
	relativePhoto: string,
	expectedStatus = 202,
	marker = `${pump.pump_code}-${relativePhoto}`
) {
	const buffer = await taggedFixture(relativePhoto, marker);
	const response = await request.post('/api/attendance/submit', {
		headers: { cookie: `session=${cookieFor(pump)}`, origin: baseUrl },
		multipart: {
			photo: {
				name: path.basename(relativePhoto),
				mimeType: 'image/jpeg',
				buffer
			}
		}
	});
	const rawBody = await response.text();
	expect(response.status(), rawBody).toBe(expectedStatus);
	try {
		return JSON.parse(rawBody);
	} catch {
		return {};
	}
}

async function pollStatus(request: APIRequestContext, pump: Pump, sessionId: string) {
	await expect
		.poll(
			async () => {
				const response = await request.get(`/api/attendance/status/${sessionId}`, {
					headers: { cookie: `session=${cookieFor(pump)}` }
				});
				const body = await response.json();
				return body.status;
			},
			{ timeout: 4 * 60 * 1000, intervals: [1000, 2000] }
		)
		.toMatch(/completed|failed/);
	const response = await request.get(`/api/attendance/status/${sessionId}`, {
		headers: { cookie: `session=${cookieFor(pump)}` }
	});
	return response.json();
}

test.beforeAll(async () => {
	await setupHierarchy();
	const runId = (await fs.readFile('test-output/attendance-e2e/latest-run.txt', 'utf8')).trim();
	screenshotRoot = path.resolve('test-output', 'attendance-e2e', runId, 'screenshots');
	await fs.mkdir(screenshotRoot, { recursive: true });
});

test.afterAll(async () => {
	await pool.end();
});

test.describe.serial('real pump attendance pipeline', () => {
	test('live UI values update through morning, waiting, evening, and locked states', async ({
		page,
		request,
		context
	}) => {
		const pump = pumps[0];
		await authenticate(page, pump);
		await context.grantPermissions(['geolocation'], { origin: baseUrl });
		await context.setGeolocation({ latitude: 12.9716, longitude: 77.5946 });
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/pump');

		await expect(page.getByTestId('session-title')).toHaveText('Start shift');
		await expect(page.getByText('Start open', { exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Submit group photo' })).toHaveCount(0);

		const morningBytes = await taggedFixture('photos/b-01-baseline.jpg', 'flow-morning');
		await page.getByTestId('capture-input').setInputFiles({
			name: 'b-01-baseline.jpg',
			mimeType: 'image/jpeg',
			buffer: morningBytes
		});
		await expect(page.getByAltText('Selected group attendance preview')).toBeVisible();
		await expect(page.getByText('b-01-baseline.jpg', { exact: true })).toBeVisible();
		await expect(page.locator('.photo-meta span').nth(1)).toHaveText(/\d+\.\d MB/);
		await expect(page.getByRole('button', { name: 'Submit group photo' })).toBeVisible();
		await page.screenshot({
			path: path.join(screenshotRoot, '01-morning-photo-selected.png'),
			fullPage: true
		});

		await page.getByRole('button', { name: 'Submit group photo' }).click();
		await expect(page.getByTestId('status-processing')).toBeVisible({ timeout: 15_000 });
		await expect(page.locator('.processing-list li').nth(0)).toHaveClass(/active/);
		await expect(page.locator('.processing-list li').nth(1)).not.toHaveClass(/active/);
		await page.waitForTimeout(7000);
		if (await page.getByTestId('status-processing').isVisible()) {
			await expect(page.locator('.processing-list li').nth(1)).toHaveClass(/active/);
			await page.screenshot({
				path: path.join(screenshotRoot, '02-morning-processing-midpoint.png'),
				fullPage: true
			});
		}

		await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 4 * 60 * 1000 });
		await expect(page.getByRole('heading', { name: '30 people found' })).toBeVisible();
		await expect(page.getByRole('heading', { name: /New people/ })).toContainText('30');
		await expect(page.getByRole('heading', { name: /Matched/ })).toHaveCount(0);

		const morningSession = await pool.query(
			`SELECT id FROM attendance_sessions WHERE pump_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
			[pump.id]
		);
		const morningSessionId = morningSession.rows[0].id;
		const morningStatus = await pollStatus(request, pump, morningSessionId);
		expect(morningStatus.new_persons).toHaveLength(30);
		expect(morningStatus.matched).toHaveLength(0);

		await page.getByRole('button', { name: 'Done' }).click();
		await expect(page.getByTestId('session-title')).toHaveText('Shift in progress');
		await expect(page.getByText('Waiting', { exact: true })).toBeVisible();
		await expect(page.getByText(/^Available /)).toBeVisible();
		await page.screenshot({
			path: path.join(screenshotRoot, '03-evening-waiting-partial-state.png'),
			fullPage: true
		});

		await submitApi(request, pump, 'photos/a-03-compressed.jpg', 409);
		const beforeEvening = await pool.query(
			`SELECT count(*)::int AS count FROM attendance_sessions WHERE pump_id = $1`,
			[pump.id]
		);
		expect(beforeEvening.rows[0].count).toBe(1);

		await pool.query(
			`UPDATE attendance_sessions SET submitted_at = submitted_at - interval '10 hours'
			 WHERE id = $1`,
			[morningSessionId]
		);
		await page.reload();
		await expect(page.getByTestId('session-title')).toHaveText('End shift');
		await expect(page.getByText('End open', { exact: true })).toBeVisible();

		await page.getByTestId('capture-input').setInputFiles({
			name: 'b-02-lowlight.jpg',
			mimeType: 'image/jpeg',
			buffer: await taggedFixture('photos/b-02-lowlight.jpg', 'flow-evening')
		});
		await expect(page.getByText('b-02-lowlight.jpg', { exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Submit group photo' }).click();
		await expect(page.getByTestId('status-processing')).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 4 * 60 * 1000 });
		await expect(page.getByRole('heading', { name: '30 people found' })).toBeVisible();
		await expect(page.getByRole('heading', { name: /Matched/ })).toContainText('30');
		await expect(page.getByRole('heading', { name: /New people/ })).toHaveCount(0);
		await page.screenshot({
			path: path.join(screenshotRoot, '04-evening-matched-result.png'),
			fullPage: true
		});

		const sessions = await pool.query(
			`SELECT id, session_type, session_date, paired_session_id, pairing_status
			 FROM attendance_sessions WHERE pump_id = $1 ORDER BY submitted_at`,
			[pump.id]
		);
		expect(sessions.rows).toHaveLength(2);
		const eveningSession = sessions.rows.find((row) => row.session_type === 'evening');
		expect(eveningSession.paired_session_id).toBe(morningSessionId);
		expect(sessions.rows.find((row) => row.session_type === 'morning').paired_session_id).toBe(
			eveningSession.id
		);

		const eveningStatus = await pollStatus(request, pump, eveningSession.id);
		expect(eveningStatus.matched).toHaveLength(30);
		expect(eveningStatus.new_persons).toHaveLength(0);
		expect(
			eveningStatus.matched.filter((person: any) =>
				eveningStatus.new_persons.some((created: any) => created.person_id === person.person_id)
			)
		).toHaveLength(0);

		const persisted = await pool.query(
			`SELECT
			   count(*)::int AS people,
			   count(*) FILTER (WHERE morning_matched AND evening_matched)::int AS present
			 FROM daily_person_attendance
			 WHERE pump_id = $1 AND session_date = $2`,
			[pump.id, eveningSession.session_date]
		);
		expect(persisted.rows[0]).toEqual({ people: 30, present: 30 });
		const yearly = await pool.query(
			`SELECT count(*)::int AS people,
			        sum(days_present)::int AS present_days,
			        sum(days_morning_only)::int AS morning_only_days,
			        sum(days_evening_only)::int AS evening_only_days
			 FROM person_attendance_yearly y
			 JOIN persons p ON p.id = y.person_id
			 WHERE p.pump_id = $1`,
			[pump.id]
		);
		expect(yearly.rows[0]).toEqual({
			people: 30,
			present_days: 30,
			morning_only_days: 0,
			evening_only_days: 0
		});

		await page.getByRole('button', { name: 'Done' }).click();
		await expect(page.getByTestId('session-title')).toHaveText('Shift complete');
		await expect(page.getByText('Complete', { exact: true })).toBeVisible();
		await submitApi(request, pump, 'photos/a-04-center-crop.jpg', 409);
	});

	test('midnight pairing inherits the morning date and links both sessions', async ({
		request
	}) => {
		const pump = pumps[1];
		const morning = await submitApi(request, pump, 'photos/d-01-baseline.jpg');
		await pollStatus(request, pump, morning.session_id);
		await pool.query(
			`UPDATE attendance_sessions
			 SET submitted_at = submitted_at - interval '10 hours',
			     session_date = current_date - 1
			 WHERE id = $1`,
			[morning.session_id]
		);
		await pool.query(
			`UPDATE daily_person_attendance SET session_date = current_date - 1
			 WHERE pump_id = $1`,
			[pump.id]
		);

		const evening = await submitApi(request, pump, 'photos/d-02-lowlight.jpg');
		await pollStatus(request, pump, evening.session_id);
		const result = await pool.query(
			`SELECT morning.session_date AS morning_date, evening.session_date AS evening_date,
			        morning.paired_session_id AS morning_pair,
			        evening.paired_session_id AS evening_pair
			 FROM attendance_sessions morning
			 JOIN attendance_sessions evening ON evening.id = $2
			 WHERE morning.id = $1`,
			[morning.session_id, evening.session_id]
		);
		expect(String(result.rows[0].evening_date)).toBe(String(result.rows[0].morning_date));
		expect(result.rows[0].morning_pair).toBe(evening.session_id);
		expect(result.rows[0].evening_pair).toBe(morning.session_id);
	});

	test('expired morning finalizes morning-only and permits a fresh morning', async ({
		request
	}) => {
		const pump = pumps[2];
		const stale = await submitApi(request, pump, 'photos/c-01-baseline.jpg');
		const staleStatus = await pollStatus(request, pump, stale.session_id);
		expect(staleStatus.new_persons.length).toBeGreaterThan(0);
		await pool.query(
			`UPDATE attendance_sessions
			 SET submitted_at = submitted_at - interval '25 hours',
			     session_date = current_date - 2
			 WHERE id = $1`,
			[stale.session_id]
		);
		await pool.query(
			`UPDATE daily_person_attendance SET session_date = current_date - 2 WHERE pump_id = $1`,
			[pump.id]
		);

		const today = await request.get('/api/attendance/today', {
			headers: { cookie: `session=${cookieFor(pump)}` }
		});
		expect(today.status()).toBe(200);
		expect((await today.json()).state).toBe('morning');
		const expiry = await pool.query(
			`SELECT s.pairing_status,
			        count(y.person_id)::int AS yearly_people,
			        COALESCE(sum(y.days_morning_only), 0)::int AS morning_only_days
			 FROM attendance_sessions s
			 LEFT JOIN persons p ON p.pump_id = s.pump_id
			 LEFT JOIN person_attendance_yearly y ON y.person_id = p.id
			 WHERE s.id = $1
			 GROUP BY s.pairing_status`,
			[stale.session_id]
		);
		expect(expiry.rows[0].pairing_status).toBe('expired');
		expect(expiry.rows[0].yearly_people).toBe(staleStatus.new_persons.length);
		expect(expiry.rows[0].morning_only_days).toBe(staleStatus.new_persons.length);

		const fresh = await submitApi(request, pump, 'photos/c-02-lowlight.jpg');
		const freshStatus = await pollStatus(request, pump, fresh.session_id);
		expect(freshStatus.session_type).toBe('morning');
	});

	test('duplicate bytes reject globally and zero-face images complete without attendance', async ({
		request
	}) => {
		const pump = pumps[3];
		await submitApi(request, pump, 'photos/b-01-baseline.jpg', 409, 'flow-morning');
		const duplicateRows = await pool.query(
			`SELECT count(*)::int AS count FROM attendance_sessions WHERE pump_id = $1`,
			[pump.id]
		);
		expect(duplicateRows.rows[0].count).toBe(0);

		const empty = await submitApi(request, pump, 'negative/no-face.jpg');
		const result = await pollStatus(request, pump, empty.session_id);
		expect(result.status).toBe('completed');
		expect(result.matched).toHaveLength(0);
		expect(result.new_persons).toHaveLength(0);
		const persisted = await pool.query(
			`SELECT
			   (SELECT count(*) FROM persons WHERE pump_id = $1)::int AS people,
			   (SELECT count(*) FROM daily_person_attendance WHERE pump_id = $1)::int AS attendance`,
			[pump.id]
		);
		expect(persisted.rows[0]).toEqual({ people: 0, attendance: 0 });
	});

	test('corrupt images exhaust bounded retries and oversized uploads leave no rows', async ({
		request
	}) => {
		const corruptPump = pumps[4];
		const corrupt = await submitApi(request, corruptPump, 'negative/corrupt-image.jpg');
		const failed = await pollStatus(request, corruptPump, corrupt.session_id);
		expect(failed.status).toBe('failed');
		expect(failed.error_reason).toBeTruthy();
		const failedJob = await pool.query(
			`SELECT status, attempts, last_error FROM attendance_jobs WHERE session_id = $1`,
			[corrupt.session_id]
		);
		expect(failedJob.rows[0].status).toBe('error');
		expect(failedJob.rows[0].attempts).toBe(3);
		expect(failedJob.rows[0].last_error).toBeTruthy();

		const largePump = pumps[5];
		const oversized = Buffer.alloc(21 * 1024 * 1024, 65);
		const response = await request.post('/api/attendance/submit', {
			headers: { cookie: `session=${cookieFor(largePump)}`, origin: baseUrl },
			multipart: {
				photo: {
					name: 'oversized.jpg',
					mimeType: 'image/jpeg',
					buffer: oversized
				}
			}
		});
		expect(response.status()).toBeGreaterThanOrEqual(400);
		expect(response.status()).toBeLessThan(500);
		const rows = await pool.query(
			`SELECT count(*)::int AS sessions,
			        (SELECT count(*) FROM attendance_jobs j
			         JOIN attendance_sessions s ON s.id = j.session_id
			         WHERE s.pump_id = $1)::int AS jobs
			 FROM attendance_sessions WHERE pump_id = $1`,
			[largePump.id]
		);
		expect(rows.rows[0]).toEqual({ sessions: 0, jobs: 0 });
	});

	test('pump derived state has an explicit Svelte dependency', async () => {
		const source = await fs.readFile('src/routes/pump/+page.svelte', 'utf8');
		expect(source).toContain('const sessionTitle = $derived.by(() =>');
		expect(source).toContain('data-testid="session-title">{sessionTitle}');
		expect(source).not.toContain('{sessionTitle()}');
	});
});
