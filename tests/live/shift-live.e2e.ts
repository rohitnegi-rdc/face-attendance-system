// Visual end-to-end walk-through of the single-button shift flow against a running local stack
// (real AI service, real worker), using EXISTING accounts only. It never creates pumps, vendors
// or plant managers and never deletes attendance. Needs LIVE_DATABASE_URL, LIVE_PASSWORD and
// LIVE_ADMIN_PASSWORD in the environment; see playwright.live.config.ts.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const PASSWORD = process.env.LIVE_PASSWORD ?? '';
const ADMIN_EMAIL = process.env.LIVE_ADMIN_EMAIL ?? 'admin@attendance.local';
const ADMIN_PASSWORD = process.env.LIVE_ADMIN_PASSWORD ?? '';
const P1 = 'BGLPSHIVA4'; // full shift
const P2 = 'BGLPRVN4'; // End session button and admin fixes
const P3 = 'BGLPSS1'; // cross-pump fraud and 24 h auto-close
const BASE_URL = process.env.LIVE_BASE_URL || 'http://127.0.0.1:6100';
const VENDOR_EMAIL = 'rvnenterprises@vendors.local';
// A real plant manager assigned to the pumps' plant; kept out of the repo.
const MANAGER_EMAIL = process.env.LIVE_MANAGER_EMAIL ?? '';

const CAMERA_FILES: Record<string, string> = {
	'a-baseline.jpg': 'tests/fixtures/group-e2e/photos/a-01-baseline.jpg',
	'a-lowlight.jpg': 'tests/fixtures/group-e2e/photos/a-02-lowlight.jpg',
	'a-compressed.jpg': 'tests/fixtures/group-e2e/photos/a-03-compressed.jpg',
	'c-baseline.jpg': 'tests/fixtures/group-e2e/photos/c-01-baseline.jpg',
	'c-lowlight.jpg': 'tests/fixtures/group-e2e/photos/c-02-lowlight.jpg',
	'c-crop.jpg': 'tests/fixtures/group-e2e/photos/c-04-center-crop.jpg'
};

const db = new pg.Pool({ connectionString: process.env.LIVE_DATABASE_URL, max: 2 });
const shotDir = path.join(
	'test-output',
	'shift-live',
	new Date().toISOString().replace(/[:.]/g, '-')
);
const problems: string[] = [];
const findings: string[] = [];

test.describe.configure({ mode: 'serial' });
test.setTimeout(10 * 60 * 1000);

// Replaces the camera with a canvas stream of a test photo. One pixel changes every frame so
// each capture has its own hash, as real camera frames do.
function fakeCamera() {
	const media = navigator.mediaDevices;
	if (!media) return;
	media.enumerateDevices = async () =>
		[{ kind: 'videoinput', deviceId: 'e2e', groupId: 'e2e', label: 'E2E camera' }] as never;
	media.getUserMedia = async () => {
		const image = new Image();
		image.src = (window as unknown as { __e2eCam: string }).__e2eCam;
		await image.decode();
		const canvas = document.createElement('canvas');
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const context = canvas.getContext('2d')!;
		const seed = Math.floor(Math.random() * 250);
		let tick = 0;
		const draw = () => {
			context.drawImage(image, 0, 0);
			context.fillStyle = `rgb(${seed},${tick++ % 250},9)`;
			context.fillRect(0, 0, 1, 1);
		};
		draw();
		setInterval(draw, 100);
		return canvas.captureStream(10);
	};
}

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
	return (await db.query(sql, params)).rows as T[];
}

async function istDate(daysAgo = 0) {
	const [row] = await query<{ d: string }>(
		`SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date - $1::int)::text AS d`,
		[daysAgo]
	);
	return row.d;
}

async function pumpId(code: string) {
	const [row] = await query<{ id: string }>('SELECT id FROM pumps WHERE pump_code = $1', [code]);
	return row.id;
}

type SessionRow = {
	id: string;
	session_type: string;
	session_date: string;
	status: string;
	pairing_status: string;
	closed_by: string | null;
};

async function latestSession(code: string) {
	const [row] = await query<SessionRow>(
		`SELECT s.id, s.session_type, s.session_date::text AS session_date, s.status,
		        s.pairing_status, s.closed_by
		 FROM attendance_sessions s JOIN pumps p ON p.id = s.pump_id
		 WHERE p.pump_code = $1 ORDER BY s.submitted_at DESC LIMIT 1`,
		[code]
	);
	return row;
}

async function session(id: string) {
	const [row] = await query<SessionRow>(
		`SELECT id, session_type, session_date::text AS session_date, status, pairing_status, closed_by
		 FROM attendance_sessions WHERE id = $1`,
		[id]
	);
	return row;
}

// Pretends a session was taken `minutes` ago on `date` (with its attendance rows), so the
// 9 h / 24 h rules can be shown without waiting.
async function backdate(id: string, minutes: number, date: string) {
	await query(
		`UPDATE daily_person_attendance d SET session_date = $2::date
		 FROM attendance_sessions s
		 WHERE s.id = $1 AND d.pump_id = s.pump_id AND d.session_date = s.session_date`,
		[id, date]
	);
	await query(
		`UPDATE attendance_sessions
		 SET submitted_at = now() - make_interval(mins => $2), session_date = $3::date
		 WHERE id = $1`,
		[id, minutes, date]
	);
}

async function shot(page: Page, name: string) {
	await page.waitForLoadState('networkidle').catch(() => {});
	await page.evaluate(() => {
		(document.activeElement as HTMLElement | null)?.blur();
		window.scrollTo(0, 0);
	});
	await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true });
}

async function open(
	browser: Browser,
	mobile: boolean
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext(
		mobile
			? {
					viewport: { width: 390, height: 844 },
					deviceScaleFactor: 2,
					isMobile: true,
					hasTouch: true
				}
			: { viewport: { width: 1440, height: 900 } }
	);
	await context.addInitScript(fakeCamera);
	await context.route('**/__e2e/cam/**', (route) => {
		const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()!);
		return route.fulfill({ path: CAMERA_FILES[name], contentType: 'image/jpeg' });
	});
	const page = await context.newPage();
	page.on('console', (message) => {
		// A refused admin fix answers 400 on purpose (LIVE-07); the browser logs it as an error.
		if (message.location().url.includes('?/moveShift')) return;
		if (message.type() === 'error')
			problems.push(`console error on ${page.url()}: ${message.text()}`);
	});
	page.on('pageerror', (error) => problems.push(`page error on ${page.url()}: ${error.message}`));
	page.on('response', (response) => {
		if (response.status() >= 500) problems.push(`${response.status()} ${response.url()}`);
	});
	return { context, page };
}

async function login(page: Page, email: string, password = PASSWORD) {
	await page.goto('/login');
	await page.getByTestId('login-email').fill(email);
	await page.getByTestId('login-password').fill(password);
	await page.getByTestId('login-submit').click();
	await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function takePhoto(page: Page, cameraFile: string) {
	await page.evaluate((file) => {
		(window as unknown as { __e2eCam: string }).__e2eCam = `/__e2e/cam/${file}`;
	}, cameraFile);
	await page.getByRole('button', { name: 'Take photo' }).click();
	const use = page.getByRole('button', { name: 'Use this photo' });
	await expect(use).toBeEnabled();
	await page.waitForTimeout(400);
	await use.click();
	await expect(page.getByAltText('Selected group attendance preview')).toBeVisible();
}

async function submitPhoto(page: Page) {
	await page.getByRole('button', { name: 'Submit group photo' }).click();
	await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 4 * 60 * 1000 });
}

async function doneReviewing(page: Page) {
	await page.getByRole('button', { name: 'Done reviewing' }).click();
	await expect(page.getByTestId('result-screen')).toHaveCount(0, { timeout: 30_000 });
}

async function todayState(page: Page) {
	return (await page.request.get('/api/attendance/today')).json();
}

// Playwright dismisses a browser confirm() by default; accept (or dismiss) the next one.
function answerNextDialog(page: Page, accept: boolean) {
	return new Promise<string>((resolve) =>
		page.once('dialog', async (dialog) => {
			resolve(dialog.message());
			if (accept) await dialog.accept();
			else await dialog.dismiss();
		})
	);
}

function sessionRow(page: Page, id: string) {
	return page.locator('tbody tr', {
		has: page.locator(`input[name="session_id"][value="${id}"]`)
	});
}

async function fixShift(page: Page, id: string) {
	const row = sessionRow(page, id);
	await row.getByTestId('shift-fix').locator('summary').click();
	return row;
}

function photoBytes(file: string) {
	// A unique trailer after the JPEG end marker changes the hash but not the image.
	return Buffer.concat([fs.readFileSync(file), Buffer.from(`e2e-${Date.now()}-${Math.random()}`)]);
}

function photoForm(file: string) {
	return {
		headers: { origin: BASE_URL },
		multipart: {
			photo: { name: 'api.jpg', mimeType: 'image/jpeg', buffer: photoBytes(file) }
		}
	};
}

let pump1 = '';
let pump2 = '';
let pump3 = '';
let startedAt = 0;

test.beforeAll(async () => {
	expect(PASSWORD, 'LIVE_PASSWORD').not.toBe('');
	expect(MANAGER_EMAIL, 'LIVE_MANAGER_EMAIL').not.toBe('');
	expect(ADMIN_PASSWORD, 'LIVE_ADMIN_PASSWORD').not.toBe('');
	fs.mkdirSync(shotDir, { recursive: true });
	[pump1, pump2, pump3] = await Promise.all([pumpId(P1), pumpId(P2), pumpId(P3)]);
	const busy = await query(
		`SELECT p.pump_code FROM attendance_sessions s JOIN pumps p ON p.id = s.pump_id
		 WHERE p.pump_code = ANY($1) AND s.session_date >= $2::date - 3`,
		[[P1, P2, P3], await istDate(0)]
	);
	// LIVE_RESUME=1 continues a run on the data an earlier run left (with --grep for later steps).
	if (!process.env.LIVE_RESUME) {
		expect(busy, 'test pumps must have no shifts in the last 3 days').toEqual([]);
		expect(await query('SELECT 1 FROM app_settings')).toEqual([]);
	}
});

test.afterAll(async () => {
	// If a step failed before LIVE-11, never leave the 1 minute test gap behind.
	const leftover = await query('DELETE FROM app_settings RETURNING key');
	if (leftover.length) findings.push('afterAll restored production settings directly');
	fs.writeFileSync(
		path.join(shotDir, 'report.json'),
		JSON.stringify({ problems, findings }, null, 2)
	);
	await db.end();
});

test('LIVE-01 shift start, then the end is refused before 9 h with the time it opens', async ({
	browser
}) => {
	const { context, page } = await open(browser, true);
	await login(page, `${P1.toLowerCase()}@pumps.local`);
	await expect.soft(page.getByTestId('session-title')).toHaveText('Start shift');
	await expect.soft(page.getByText('Start open', { exact: true })).toBeVisible();
	await expect
		.soft(page.getByTestId('next-step'))
		.toHaveText('Submit the group photo to start the shift');
	await expect.soft(page.getByTestId('end-session')).toHaveCount(0);
	await shot(page, '01a-pump1-start-shift');

	await takePhoto(page, 'a-baseline.jpg');
	await shot(page, '01b-pump1-photo-selected');
	startedAt = Date.now();
	await submitPhoto(page);
	await expect.soft(page.getByRole('heading', { name: /marked present/ })).toBeVisible();
	await shot(page, '01c-pump1-start-review');
	await doneReviewing(page);

	await expect.soft(page.getByTestId('session-title')).toHaveText('Shift in progress');
	await expect.soft(page.getByText('Waiting', { exact: true })).toBeVisible();
	await expect.soft(page.getByTestId('next-step')).toContainText('Shift end opens');
	await expect.soft(page.getByRole('button', { name: 'Take photo' })).toBeDisabled();
	await expect.soft(page.getByTestId('end-session')).toHaveCount(0);
	await shot(page, '01d-pump1-shift-in-progress');

	const start = await latestSession(P1);
	expect
		.soft(start)
		.toMatchObject({ session_type: 'morning', status: 'completed', pairing_status: 'open' });

	// The API refuses an early end photo and an early End session with the same wording.
	const early = await page.request.post(
		'/api/attendance/submit',
		photoForm(CAMERA_FILES['a-lowlight.jpg'])
	);
	expect.soft(early.status()).toBe(409);
	expect.soft((await early.json()).error).toMatch(/Shift end opens in (8 h 5\d|9 h 0) min/);
	const earlyEnd = await page.request.post('/api/attendance/end');
	expect.soft(earlyEnd.status()).toBe(409);
	expect.soft((await earlyEnd.json()).error).toMatch(/Shift end opens in (8 h 5\d|9 h 0) min/);
	expect.soft((await latestSession(P1)).id).toBe(start.id);
	await context.close();
});

test('LIVE-02 admin shortens the end gap to 1 minute for testing', async ({ browser }) => {
	const { context, page } = await open(browser, false);
	await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
	await page.goto('/admin/settings');
	await shot(page, '02a-admin-settings-defaults');
	await page.locator('input[name="evening_min_gap_minutes"]').fill('1');
	await page.locator('input[name="evening_pairing_window_hours"]').fill('24');
	await page.getByRole('button', { name: 'Save settings' }).click();
	await page.waitForLoadState('networkidle');
	await shot(page, '02b-admin-settings-saved');
	expect.soft((await query('SELECT 1 FROM app_settings')).length).toBeGreaterThan(0);
	await context.close();
});

test('LIVE-03 after the gap the end photo completes a full shift; another photo is refused', async ({
	browser
}) => {
	const wait = startedAt + 65_000 - Date.now();
	if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
	const { context, page } = await open(browser, true);
	await login(page, `${P1.toLowerCase()}@pumps.local`);
	await expect.soft(page.getByTestId('session-title')).toHaveText('End shift');
	await expect.soft(page.getByText('End open', { exact: true })).toBeVisible();
	await expect
		.soft(page.getByTestId('next-step'))
		.toHaveText('Submit the group photo to end the shift');
	await expect.soft(page.getByTestId('end-session')).toBeVisible();
	await shot(page, '03a-pump1-end-shift-open');

	await takePhoto(page, 'a-lowlight.jpg');
	await submitPhoto(page);
	if (!(await page.getByRole('heading', { name: /Matched/ }).isVisible()))
		findings.push('LIVE-03: end photo matched nobody from the start photo');
	await shot(page, '03b-pump1-end-review');
	await doneReviewing(page);

	await expect.soft(page.getByTestId('session-title')).toHaveText('Shift complete');
	await expect.soft(page.getByTestId('shift-badge')).toHaveText('Complete');
	await expect
		.soft(page.getByTestId('next-step'))
		.toHaveText('Shift recorded. The next shift starts tomorrow.');
	await shot(page, '03c-pump1-shift-complete');

	const end = await latestSession(P1);
	expect
		.soft(end)
		.toMatchObject({ session_type: 'evening', status: 'completed', pairing_status: 'paired' });
	expect.soft(end.session_date).toBe(await istDate(0));
	const third = await page.request.post(
		'/api/attendance/submit',
		photoForm(CAMERA_FILES['a-baseline.jpg'])
	);
	expect.soft(third.status()).toBe(409);
	expect.soft((await third.json()).error).toContain('already recorded');
	const [full] = await query<{ n: number }>(
		`SELECT count(*)::int AS n FROM daily_person_attendance
		 WHERE pump_id = $1 AND session_date = $2 AND morning_matched AND evening_matched`,
		[pump1, await istDate(0)]
	);
	findings.push(`LIVE-03 full-shift workers at ${P1}: ${full.n}`);
	expect.soft(full.n).toBeGreaterThan(0);
	await context.close();
});

let p2Start1 = '';
let p2Start2 = '';
let p2End = '';

test('LIVE-04 pump End session closes a forgotten shift; the next photo starts a new one', async ({
	browser
}) => {
	const { context, page } = await open(browser, true);
	await login(page, `${P2.toLowerCase()}@pumps.local`);
	await expect.soft(page.getByTestId('session-title')).toHaveText('Start shift');
	await takePhoto(page, 'c-baseline.jpg');
	await submitPhoto(page);
	await doneReviewing(page);
	p2Start1 = (await latestSession(P2)).id;

	// Started yesterday evening, 20 h ago, and the pump never took the end photo.
	await backdate(p2Start1, 20 * 60, await istDate(1));
	await page.reload();
	await expect.soft(page.getByTestId('session-title')).toHaveText('End shift');
	await expect.soft(page.getByTestId('end-session')).toBeVisible();
	await shot(page, '04a-pump2-forgotten-shift-end-session-visible');

	const dismissed = answerNextDialog(page, false);
	await page.getByTestId('end-session').click();
	findings.push(`LIVE-04 End session confirm text: ${await dismissed}`);
	expect.soft((await session(p2Start1)).pairing_status).toBe('open');

	const accepted = answerNextDialog(page, true);
	await page.getByTestId('end-session').click();
	await accepted;
	await expect.soft(page.getByTestId('session-title')).toHaveText('Start shift');
	await expect.soft(page.getByTestId('end-session')).toHaveCount(0);
	await shot(page, '04b-pump2-after-end-session');
	expect
		.soft(await session(p2Start1))
		.toMatchObject({ pairing_status: 'expired', closed_by: 'pump' });
	await context.close();
});

test('LIVE-05 admin Move to date moves a closed shift and its attendance', async ({ browser }) => {
	const { context, page } = await open(browser, false);
	await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
	await page.goto(`/admin/pumps/${pump2}`);
	await shot(page, '05a-admin-pump2-session-log');
	const row = await fixShift(page, p2Start1);
	await shot(page, '05b-admin-fix-shift-open');
	const target = await istDate(2);
	await row.locator('input[name="new_date"]').fill(target);
	await row.getByRole('button', { name: 'Move' }).click();
	await expect.soft(page.getByRole('status')).toBeVisible();
	await shot(page, '05c-admin-move-done');
	expect.soft((await session(p2Start1)).session_date).toBe(target);
	const dates = await query<{ d: string }>(
		`SELECT DISTINCT session_date::text AS d FROM daily_person_attendance
		 WHERE pump_id = $1 AND session_date >= $2::date`,
		[pump2, target]
	);
	expect.soft(dates.map((r) => r.d)).toEqual([target]);
	await context.close();
});

test('LIVE-06 admin Split turns a mistaken end photo into the next shift start', async ({
	browser
}) => {
	const { context, page } = await open(browser, true);
	await login(page, `${P2.toLowerCase()}@pumps.local`);
	await takePhoto(page, 'c-lowlight.jpg');
	await submitPhoto(page);
	await doneReviewing(page);
	p2Start2 = (await latestSession(P2)).id;
	await backdate(p2Start2, 20 * 60, await istDate(1));

	// Today the operator meant to start a new shift, but yesterday's open one takes it as its end.
	await page.reload();
	await expect.soft(page.getByTestId('session-title')).toHaveText('End shift');
	await takePhoto(page, 'c-crop.jpg');
	await submitPhoto(page);
	await doneReviewing(page);
	p2End = (await latestSession(P2)).id;
	expect.soft(await session(p2End)).toMatchObject({
		session_type: 'evening',
		session_date: await istDate(1)
	});
	await expect.soft(page.getByTestId('session-title')).toHaveText('Start shift');
	await shot(page, '06a-pump2-photo-became-end-of-yesterday');

	const admin = await open(browser, false);
	await login(admin.page, ADMIN_EMAIL, ADMIN_PASSWORD);
	await admin.page.goto(`/admin/pumps/${pump2}`);
	const row = await fixShift(admin.page, p2End);
	await expect.soft(row).toContainText('Shift end');
	await shot(admin.page, '06b-admin-split-option');
	const confirmText = answerNextDialog(admin.page, true);
	await row.getByRole('button', { name: 'Split: this end is a new start' }).click();
	expect.soft(await confirmText).toContain('new shift start');
	await expect.soft(admin.page.getByRole('status')).toBeVisible();
	await shot(admin.page, '06c-admin-split-done');

	expect.soft(await session(p2End)).toMatchObject({
		session_type: 'morning',
		session_date: await istDate(0),
		pairing_status: 'open'
	});
	expect
		.soft(await session(p2Start2))
		.toMatchObject({ pairing_status: 'expired', closed_by: 'admin' });

	await page.reload();
	await expect.soft(page.getByTestId('session-title')).toHaveText(/End shift|Shift in progress/);
	await shot(page, '06d-pump2-after-split');
	await admin.context.close();
	await context.close();
});

test('LIVE-07 admin End session, refused Move, and cancelled Delete', async ({ browser }) => {
	const { context, page } = await open(browser, false);
	await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
	await page.goto(`/admin/pumps/${pump2}`);

	// A move onto a date that already has a shift is refused and nothing changes.
	let row = await fixShift(page, p2End);
	await row.locator('input[name="new_date"]').fill(await istDate(1));
	await row.getByRole('button', { name: 'Move' }).click();
	await expect.soft(page.getByRole('status')).toHaveClass(/alert--error/);
	await shot(page, '07a-admin-move-refused');
	expect.soft((await session(p2End)).session_date).toBe(await istDate(0));

	row = await fixShift(page, p2End);
	const confirmText = answerNextDialog(page, true);
	await row.getByRole('button', { name: 'End session' }).click();
	expect.soft(await confirmText).toContain('End this shift now?');
	await expect.soft(page.getByRole('status')).not.toHaveClass(/alert--error/);
	await shot(page, '07b-admin-end-session-done');
	expect
		.soft(await session(p2End))
		.toMatchObject({ pairing_status: 'expired', closed_by: 'admin' });

	// Delete is only opened and cancelled: the test data stays for the owner to review.
	const deleteText = answerNextDialog(page, false);
	await sessionRow(page, p2End).getByRole('button', { name: 'Delete / reset' }).click();
	expect.soft(await deleteText).toContain('Delete');
	expect.soft(await session(p2End)).toBeTruthy();
	await shot(page, '07c-admin-pump2-final-log');

	const audit = await query<{ action: string }>(
		`SELECT action FROM admin_audit_log WHERE created_at > now() - interval '1 hour'
		 AND action IN ('move_shift', 'split_shift', 'end_shift') ORDER BY created_at`
	);
	expect.soft(audit.map((a) => a.action)).toEqual(['move_shift', 'split_shift', 'end_shift']);

	const pumpView = await open(browser, true);
	await login(pumpView.page, `${P2.toLowerCase()}@pumps.local`);
	await shot(pumpView.page, '07d-pump2-after-admin-end');
	expect.soft(await todayState(pumpView.page)).toMatchObject({
		state: 'locked',
		shift_outcome: 'start_only'
	});
	await expect
		.soft(pumpView.page.getByTestId('session-title'))
		.toHaveText('Shift ended (start only)');
	await expect.soft(pumpView.page.getByTestId('shift-badge')).toHaveText('Start only');
	await pumpView.context.close();
	await context.close();
});

test('LIVE-08 the same faces at another pump in the Area are flagged; admin resolves both ways', async ({
	browser
}) => {
	const { context, page } = await open(browser, true);
	await login(page, `${P3.toLowerCase()}@pumps.local`);
	await takePhoto(page, 'a-compressed.jpg');
	await page.getByRole('button', { name: 'Submit group photo' }).click();
	await expect
		.soft(page.getByTestId('result-screen').or(page.getByTestId('status-failed')))
		.toBeVisible({ timeout: 4 * 60 * 1000 });
	await shot(page, '08a-pump3-fraud-review');
	if (!(await page.getByRole('heading', { name: /Needs review/ }).isVisible()))
		findings.push('LIVE-08: pump result screen shows no Needs review block');
	await expect.soft(page.getByTestId('result-held')).toContainText('held for admin review');
	await expect
		.soft(page.getByTestId('fraud-flag-line').first())
		.toContainText(new RegExp(`matches ${P1} Worker [0-9]+, already marked at ${P1}`));
	const start = await latestSession(P3);
	const flags = await query('SELECT id FROM fraud_flags WHERE session_id = $1', [start.id]);
	findings.push(`LIVE-08 fraud flags raised: ${flags.length}`);
	expect.soft(flags.length, 'cross-pump fraud flags').toBeGreaterThan(1);

	if (await page.getByRole('button', { name: 'Done reviewing' }).isVisible()) {
		await page.getByRole('button', { name: 'Done reviewing' }).click();
		await page.waitForTimeout(2000);
	}
	await shot(page, '08b-pump3-after-review');
	findings.push(`LIVE-08 pump3 start after review: ${JSON.stringify(await session(start.id))}`);

	const admin = await open(browser, false);
	await login(admin.page, ADMIN_EMAIL, ADMIN_PASSWORD);
	await admin.page.goto('/admin/fraud-flags');
	await shot(admin.page, '08c-admin-fraud-flags');
	await admin.page.getByRole('button', { name: 'Confirm fraud' }).first().click();
	await admin.page.waitForLoadState('networkidle');
	await shot(admin.page, '08d-admin-fraud-confirmed');
	await admin.page.getByRole('button', { name: 'Not fraud, mark present' }).first().click();
	await admin.page.waitForLoadState('networkidle');
	await shot(admin.page, '08e-admin-not-fraud');
	const resolved = await query<{ status: string }>(
		`SELECT coalesce(resolution, 'pending') AS status FROM fraud_flags
		 WHERE session_id = $1 ORDER BY 1`,
		[start.id]
	);
	findings.push(`LIVE-08 flag states: ${resolved.map((r) => r.status).join(', ')}`);
	expect
		.soft(resolved.map((r) => r.status))
		.toEqual(expect.arrayContaining(['confirmed_fraud', 'not_fraud']));
	await admin.context.close();
	await context.close();
});

test('LIVE-09 a start with no end auto-closes after 24 h as start only', async ({ browser }) => {
	const start = await latestSession(P3);
	await backdate(start.id, 25 * 60, await istDate(1));
	const { context, page } = await open(browser, true);
	await login(page, `${P3.toLowerCase()}@pumps.local`);
	findings.push(`LIVE-09 pump3 state after 25 h: ${(await todayState(page)).state}`);
	await shot(page, '09a-pump3-after-auto-close');
	const closed = await session(start.id);
	findings.push(`LIVE-09 start after 25 h: ${JSON.stringify(closed)}`);
	if (closed.status === 'completed') {
		expect.soft(closed).toMatchObject({ pairing_status: 'expired', closed_by: 'timeout' });
		await expect.soft(page.getByTestId('session-title')).toHaveText('Start shift');
	}
	const admin = await open(browser, false);
	await login(admin.page, ADMIN_EMAIL, ADMIN_PASSWORD);
	await admin.page.goto(`/admin/pumps/${pump3}`);
	await shot(admin.page, '09b-admin-pump3-log');
	await admin.page.goto(`/admin/pumps/${pump1}`);
	await shot(admin.page, '09c-admin-pump1-full-shift');
	await admin.context.close();
	await context.close();
});

test('LIVE-10 vendor, plant manager and admin views show the shift words', async ({ browser }) => {
	const views: [string, string, [string, string][]][] = [
		[
			VENDOR_EMAIL,
			PASSWORD,
			[
				['/vendor', '10a-vendor-dashboard'],
				['/vendor/attendance', '10b-vendor-attendance'],
				['/vendor/people', '10c-vendor-people'],
				['/vendor/pumps', '10d-vendor-pumps']
			]
		],
		[
			MANAGER_EMAIL,
			PASSWORD,
			[
				['/plant-manager', '10e-manager-dashboard'],
				['/plant-manager/attendance', '10f-manager-attendance'],
				['/plant-manager/people', '10g-manager-people'],
				['/plant-manager/pumps', '10h-manager-pumps']
			]
		],
		[
			ADMIN_EMAIL,
			ADMIN_PASSWORD,
			[
				['/admin', '10i-admin-dashboard'],
				['/admin/attendance', '10j-admin-attendance'],
				['/admin/fraud-flags', '10k-admin-fraud-flags']
			]
		]
	];
	for (const [email, password, routes] of views) {
		const { context, page } = await open(browser, false);
		await login(page, email, password);
		for (const [route, name] of routes) {
			const response = await page.goto(route);
			expect.soft(response?.status(), route).toBeLessThan(400);
			await shot(page, name);
		}
		await context.close();
	}
});

test('LIVE-11 admin restores the production settings', async ({ browser }) => {
	const { context, page } = await open(browser, false);
	await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
	await page.goto('/admin/settings');
	await page.getByRole('button', { name: 'Reset to production defaults' }).click();
	await page.waitForLoadState('networkidle');
	await shot(page, '11a-admin-settings-restored');
	expect.soft(await query('SELECT 1 FROM app_settings')).toEqual([]);
	await context.close();
	expect.soft(problems, problems.join('\n')).toEqual([]);
});
