import { expect, test, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {
	completeReview,
	installFakeCamera,
	submitPhotos,
	takeMembersPhoto,
	takeOperatorPhoto,
	takeShiftPhotos,
	type CameraImage
} from './e2e-camera';

const { Pool } = pg;
const pool = new Pool({
	connectionString:
		process.env.DATABASE_URL || 'postgres://attendance:attendance@127.0.0.1:5433/attendance'
});

const PASSWORD = 'Test1234!';
const runTag = `ATTWF${Date.now()}`;
const screenshotRoot = path.resolve('test-output', 'attendance-workflow', runTag, 'screenshots');

type PumpAccount = {
	id: string;
	pump_code: string;
	login_email: string;
};

let pump: PumpAccount;
let capturePump: PumpAccount;
let failedPump: PumpAccount;
let passwordHash: string;

async function cleanupRun() {
	const pumpRows = await pool.query<{ id: string }>(
		`SELECT id FROM pumps WHERE pump_code LIKE $1 OR login_email LIKE $2`,
		['ATTWF%', 'attwf%@e2e.local']
	);
	const pumpIds = pumpRows.rows.map((row) => row.id);
	if (!pumpIds.length) return;

	const personRows = await pool.query<{ id: string }>(
		`SELECT id FROM persons WHERE pump_id = ANY($1::uuid[])`,
		[pumpIds]
	);
	const personIds = personRows.rows.map((row) => row.id);
	const sessionRows = await pool.query<{ id: string }>(
		`SELECT id FROM attendance_sessions WHERE pump_id = ANY($1::uuid[])`,
		[pumpIds]
	);
	const sessionIds = sessionRows.rows.map((row) => row.id);

	if (sessionIds.length) {
		await pool.query(
			`UPDATE attendance_sessions SET paired_session_id = NULL WHERE id = ANY($1::uuid[])`,
			[sessionIds]
		);
		await pool.query(
			`DELETE FROM fraud_flags WHERE session_id = ANY($1::uuid[]) OR matched_session_id = ANY($1::uuid[])`,
			[sessionIds]
		);
		await pool.query(`DELETE FROM attendance_review_flags WHERE session_id = ANY($1::uuid[])`, [
			sessionIds
		]);
		await pool.query(`DELETE FROM flagged_guests WHERE session_id = ANY($1::uuid[])`, [sessionIds]);
		await pool.query(`DELETE FROM attendance_face_evidence WHERE session_id = ANY($1::uuid[])`, [
			sessionIds
		]);
		await pool.query(`DELETE FROM person_face_vectors WHERE session_id = ANY($1::uuid[])`, [
			sessionIds
		]);
		await pool.query(`DELETE FROM attendance_jobs WHERE session_id = ANY($1::uuid[])`, [
			sessionIds
		]);
		await pool.query(
			`DELETE FROM attendance_rollup_finalizations WHERE session_id = ANY($1::uuid[])`,
			[sessionIds]
		);
	}

	if (personIds.length) {
		await pool.query(`DELETE FROM person_attendance_yearly WHERE person_id = ANY($1::uuid[])`, [
			personIds
		]);
		await pool.query(`DELETE FROM person_face_vectors WHERE person_id = ANY($1::uuid[])`, [
			personIds
		]);
	}
	await pool.query(`DELETE FROM daily_person_attendance WHERE pump_id = ANY($1::uuid[])`, [
		pumpIds
	]);
	await pool.query(`DELETE FROM persons WHERE pump_id = ANY($1::uuid[])`, [pumpIds]);
	await pool.query(`DELETE FROM attendance_sessions WHERE pump_id = ANY($1::uuid[])`, [pumpIds]);
	await pool.query(`DELETE FROM pumps WHERE id = ANY($1::uuid[])`, [pumpIds]);
	await pool.query(`DELETE FROM vendors WHERE email LIKE $1`, ['attwf%@e2e.local']);
	await pool.query(`DELETE FROM plants WHERE name LIKE $1`, ['ATTWF%']);
	await pool.query(`DELETE FROM areas WHERE name LIKE $1`, ['ATTWF%']);
}

async function setupHierarchy() {
	passwordHash = await bcrypt.hash(PASSWORD, 10);
}

async function createPump(suffix: string) {
	const area = await pool.query<{ id: string }>(
		`INSERT INTO areas (name) VALUES ($1) RETURNING id`,
		[`${runTag} ${suffix} Area`]
	);
	const plant = await pool.query<{ id: string }>(
		`INSERT INTO plants (area_id, name) VALUES ($1, $2) RETURNING id`,
		[area.rows[0].id, `${runTag} ${suffix} Plant`]
	);
	const vendor = await pool.query<{ id: string }>(
		`INSERT INTO vendors (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
		[
			`${runTag} ${suffix} Vendor`,
			`${runTag.toLowerCase()}-${suffix.toLowerCase()}-vendor@e2e.local`,
			passwordHash
		]
	);
	const created = await pool.query<PumpAccount>(
		`INSERT INTO pumps (plant_id, vendor_id, pump_code, login_email, password_hash, guide_done_at)
		 VALUES ($1, $2, $3, $4, $5, now())
		 RETURNING id, pump_code, login_email`,
		[
			plant.rows[0].id,
			vendor.rows[0].id,
			`${runTag}${suffix}`,
			`${runTag.toLowerCase()}-${suffix.toLowerCase()}@e2e.local`,
			passwordHash
		]
	);
	return created.rows[0];
}

async function readFixture(candidates: string[], marker: string) {
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			const buffer = await fs.readFile(path.resolve(candidate));
			return {
				name: path.basename(candidate),
				mimeType: 'image/jpeg',
				buffer: Buffer.concat([buffer, Buffer.from(`\n${runTag}:${marker}\n`)])
			};
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

async function loginAsPump(page: Page, account = pump) {
	await installFakeCamera(page);
	await page.goto('/login');
	await page.getByTestId('login-email').fill(account.login_email);
	await page.getByTestId('login-password').fill(PASSWORD);
	await page.getByTestId('login-submit').click();
	await expect(page).toHaveURL(/\/pump$/);
	await expect(page.getByTestId('session-title')).toBeVisible();
}

// Pump Operator photo, then the Pump Members photo, both through the (fake) camera.
async function choosePhoto(page: Page, fixture: CameraImage, operator: CameraImage = fixture) {
	await takeShiftPhotos(page, fixture, operator);
	await expect(page.locator('.photo-meta span').first()).toHaveText(/^camera-group-/);
}

async function expectReadyForPhotos(page: Page) {
	await expect(
		page.getByRole('button', { name: 'Take Pump Operator photo', exact: true })
	).toBeVisible();
}

async function submitAndWaitForResult(page: Page) {
	await submitPhotos(page);
	await expect(
		page.locator(
			'[data-testid="status-processing"], [data-testid="status-failed"], [data-testid="result-screen"]'
		)
	).toBeVisible();
	await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 5 * 60 * 1000 });
}

async function submitAndWaitForFailed(page: Page) {
	await submitPhotos(page);
	await expect(page.getByTestId('status-failed')).toBeVisible({ timeout: 5 * 60 * 1000 });
}

async function openFirstWorkerPreview(page: Page, screenshotName: string) {
	const firstWorker = page.getByTestId('worker-preview-trigger').first();
	await expect(firstWorker).toBeVisible();
	await firstWorker.click();
	await expect(page.getByTestId('worker-preview')).toBeVisible();
	await expect(
		page.getByTestId('worker-preview').getByRole('button', { name: 'Close worker preview' })
	).toBeFocused();
	await expect(page.getByTestId('worker-preview-image')).toBeVisible();
	await page
		.getByTestId('worker-preview')
		.screenshot({ path: path.join(screenshotRoot, screenshotName) });
}

async function closeWorkerPreview(page: Page) {
	const closeButton = page
		.getByTestId('worker-preview')
		.getByRole('button', { name: 'Close worker preview' });
	await expect(closeButton).toBeVisible();
	await closeButton.click({ timeout: 10_000 });
	await expect(page.getByTestId('worker-preview')).toHaveCount(0);
	await expect(page.getByTestId('worker-preview-trigger').first()).toBeFocused();
}

test.beforeAll(async () => {
	await fs.mkdir(screenshotRoot, { recursive: true });
	await cleanupRun();
	await setupHierarchy();
	pump = await createPump('P01');
	capturePump = await createPump('P02');
	failedPump = await createPump('P03');
});

test.afterAll(async () => {
	await cleanupRun();
	await pool.end();
});

test('retry clears a finalized evening/no-face attendance instead of showing generic failure', async ({
	page
}) => {
	const browserErrors: string[] = [];
	const failedResponses: string[] = [];
	page.on('pageerror', (error) => browserErrors.push(error.message));
	page.on('response', (response) => {
		if (response.status() >= 500) failedResponses.push(`${response.status()} ${response.url()}`);
	});

	await loginAsPump(page);
	await expect(page.getByTestId('session-title')).toHaveText('Start shift');
	await choosePhoto(
		page,
		await readFixture(
			[
				'test-output/manual-pump-fixtures/pump-fixture-morning-5.jpg',
				'Test/faces/group_morning.jpg'
			],
			'morning'
		)
	);
	await submitAndWaitForResult(page);
	await openFirstWorkerPreview(page, '01a-morning-worker-preview.png');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('worker-preview')).toHaveCount(0);
	await openFirstWorkerPreview(page, '01b-morning-worker-preview-reopened.png');
	await closeWorkerPreview(page);
	await page.screenshot({
		path: path.join(screenshotRoot, '01-morning-result.png'),
		fullPage: true
	});
	await completeReview(page);

	const morning = await pool.query<{ id: string }>(
		`SELECT id FROM attendance_sessions WHERE pump_id = $1 AND session_type = 'morning'`,
		[pump.id]
	);
	await pool.query(
		`UPDATE attendance_sessions SET submitted_at = now() - interval '5 minutes' WHERE id = $1`,
		[morning.rows[0].id]
	);

	await page.reload();
	await expect(page.getByTestId('session-title')).toHaveText('End shift');
	// No face in the Pump Members photo; the Pump Operator photo has one, and it is the only
	// face of the shift.
	await choosePhoto(
		page,
		await readFixture(['tests/fixtures/group-e2e/negative/no-face.jpg'], 'evening-no-face'),
		await readFixture(
			[
				'test-output/manual-pump-fixtures/pump-fixture-morning-5.jpg',
				'Test/faces/group_morning.jpg'
			],
			'evening-operator'
		)
	);
	await submitAndWaitForResult(page);
	await expect(page.getByTestId('result-heading')).toHaveText('1 person marked present');
	await page.screenshot({
		path: path.join(screenshotRoot, '02-evening-no-face-result.png'),
		fullPage: true
	});

	const finalizedBeforeRetry = await pool.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM attendance_rollup_finalizations WHERE pump_id = $1`,
		[pump.id]
	);
	expect(finalizedBeforeRetry.rows[0].count).toBe(1);

	await page.getByRole('button', { name: 'Retry with better photo' }).click();
	await expectReadyForPhotos(page);
	await expect(page.getByText(/Could not prepare retry/i)).toHaveCount(0);
	await page.screenshot({
		path: path.join(screenshotRoot, '03-retry-ready-for-new-photo.png'),
		fullPage: true
	});

	const retryState = await pool.query<{
		finalizations: number;
		evening_sessions: number;
		open_mornings: number;
		yearly_days: number;
	}>(
		`SELECT
		   (SELECT count(*) FROM attendance_rollup_finalizations WHERE pump_id = $1)::int AS finalizations,
		   (SELECT count(*) FROM attendance_sessions WHERE pump_id = $1 AND session_type = 'evening')::int AS evening_sessions,
		   (SELECT count(*) FROM attendance_sessions WHERE pump_id = $1 AND session_type = 'morning' AND pairing_status = 'open')::int AS open_mornings,
		   (SELECT COALESCE(sum(days_present + days_morning_only + days_evening_only), 0)
		    FROM person_attendance_yearly y
		    JOIN persons p ON p.id = y.person_id
		    WHERE p.pump_id = $1)::int AS yearly_days`,
		[pump.id]
	);
	expect(retryState.rows[0]).toEqual({
		finalizations: 0,
		evening_sessions: 0,
		open_mornings: 1,
		yearly_days: 0
	});

	await page.reload();
	await expect(page.getByTestId('session-title')).toHaveText('End shift');
	await page.goBack();
	await page.goForward();
	await expect(page.getByTestId('session-title')).toHaveText('End shift');
	await choosePhoto(
		page,
		await readFixture(
			[
				'test-output/manual-pump-fixtures/pump-fixture-evening-4.jpg',
				'Test/faces/group_evening.jpg'
			],
			'evening-retake'
		)
	);
	await submitAndWaitForResult(page);
	await openFirstWorkerPreview(page, '04-evening-worker-preview-after-retry.png');
	await closeWorkerPreview(page);
	await page.screenshot({
		path: path.join(screenshotRoot, '05-evening-result-after-retry.png'),
		fullPage: true
	});
	await completeReview(page);
	await expect(page.getByTestId('session-title')).toHaveText('Shift complete');
	expect(browserErrors).toEqual([]);
	expect(failedResponses).toEqual([]);
});

test('camera, cancel, and failed-session retry controls stay stable', async ({ page }) => {
	const browserErrors: string[] = [];
	const failedResponses: string[] = [];
	page.on('pageerror', (error) => browserErrors.push(error.message));
	page.on('response', (response) => {
		if (response.status() >= 500) failedResponses.push(`${response.status()} ${response.url()}`);
	});

	await page.context().grantPermissions(['camera']);
	await loginAsPump(page, capturePump);
	const cameraPhoto = await readFixture(
		['test-output/manual-pump-fixtures/pump-fixture-morning-5.jpg', 'Test/faces/group_morning.jpg'],
		'camera-check'
	);
	await takeOperatorPhoto(page, cameraPhoto);
	await takeMembersPhoto(page, cameraPhoto);
	await page.screenshot({
		path: path.join(screenshotRoot, '06-camera-frame-selected.png'),
		fullPage: true
	});
	await page.getByRole('button', { name: 'Cancel' }).click();
	await expectReadyForPhotos(page);

	await loginAsPump(page, failedPump);
	await choosePhoto(
		page,
		await readFixture(
			[
				'test-output/manual-pump-fixtures/pump-fixture-morning-5.jpg',
				'Test/faces/group_morning.jpg'
			],
			'failed-group'
		),
		await readFixture(['tests/fixtures/group-e2e/negative/no-face.jpg'], 'failed-no-operator-face')
	);
	await submitAndWaitForFailed(page);
	await expect(page.getByText('Could not finish')).toBeVisible();
	await page.screenshot({
		path: path.join(screenshotRoot, '08-failed-session-state.png'),
		fullPage: true
	});
	await page.getByRole('button', { name: 'Retry' }).click();
	await expectReadyForPhotos(page);
	await expect(page.getByText(/Duplicate photo/i)).toHaveCount(0);
	await page.screenshot({
		path: path.join(screenshotRoot, '09-failed-retry-reset.png'),
		fullPage: true
	});

	await choosePhoto(
		page,
		await readFixture(
			[
				'test-output/manual-pump-fixtures/pump-fixture-morning-5.jpg',
				'Test/faces/group_morning.jpg'
			],
			'failed-recovery-good-photo'
		)
	);
	await submitAndWaitForResult(page);
	await openFirstWorkerPreview(page, '10-failed-recovery-worker-preview.png');
	await closeWorkerPreview(page);
	expect(browserErrors).toEqual([]);
	expect(failedResponses).toEqual([]);
});
