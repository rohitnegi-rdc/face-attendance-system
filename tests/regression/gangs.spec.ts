// GANG: pump gangs, phase 1 (migration 056, worker/gangs.js, src/lib/server/gangs.ts). A gang is a
// crew recognised from faces only; it moves between the pumps of an Area. Switched on per Area at
// /admin/settings; an Area left off runs exactly as before. A pump can run 2 gangs on a day the
// plant manager ticks "2 gangs"; the operator taps which running shift a photo ends, but the faces
// decide. A worker counts once a day in the gang numbers. The same-day cross-pump fraud check is an
// admin switch (this suite runs with it on, scripts/run-regression.mjs; these scenarios set it).
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import {
	action,
	approve,
	clearSettings,
	createAdmin,
	createArea,
	createPlantManager,
	createPump,
	db,
	defaultOperatorPhoto,
	fraudCheck,
	login,
	photo,
	shiftBack,
	waitForSession,
	type Pump
} from './helpers';
import { noSidewaysScroll, signIn, todayIST } from './regularisationHelpers';
import { digestGangs } from '../../worker/attendanceDigest.js';
import { gangLine } from '../../worker/digestEmail.js';

const SHOTS = 'artifacts/deep-build/screenshots';
// A point in Mumbai, ~40 m from it, and ~520 m away (another pump's site).
const PUMP = { lat: 19.0596, lng: 72.9165 };
const NEAR = { lat: 19.05996, lng: 72.9165 };
const FAR = { lat: 19.06428, lng: 72.9165 };
const GAP = 600; // minutes a start is moved back so its end is open (evening gap is 540)

test.beforeEach(() => fraudCheck(false));
test.afterAll(clearSettings);

async function gangsArea({ locationCheck = false } = {}) {
	const area = await createArea();
	await db.query(
		'UPDATE areas SET gangs_enabled = true, location_check_enabled = $2 WHERE id = $1',
		[area.areaId, locationCheck]
	);
	return area;
}

async function setPumpGps(pump: Pump, at: { lat: number; lng: number }) {
	await db.query(
		`INSERT INTO pump_locations (pump_id, lat, lng, recorded_at, source)
		 VALUES ($1, $2, $3, now() - interval '1 minute', 'gps_api')`,
		[pump.id, at.lat, at.lng]
	);
}

// image / crops: real pictures (tests/regression/fixtures) for the group photo and each face, so
// screenshots show what the operator sees.
type Extra = {
	shift?: string;
	at?: { lat: number; lng: number };
	image?: string;
	crops?: string[];
};

// A shift photo the way the pump screen sends it: the group, the operator photo, the tapped gang
// ("shift": a running start's id or "new") and the phone's position.
async function send(context: APIRequestContext, faces: string[], extra: Extra = {}) {
	const group = await photo(
		faces.map((identity, index) =>
			extra.crops?.[index] ? { identity, crop: extra.crops[index] } : identity
		),
		{ image: extra.image }
	);
	const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
		photo: { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: group },
		operator_photo: {
			name: 'operator.jpg',
			mimeType: 'image/jpeg',
			buffer: await defaultOperatorPhoto(group)
		}
	};
	if (extra.shift) multipart.shift = extra.shift;
	if (extra.at) {
		multipart.lat = String(extra.at.lat);
		multipart.lng = String(extra.at.lng);
	}
	const response = await context.post('/api/attendance/submit', { multipart });
	const body = await response.json();
	expect(response.status(), JSON.stringify(body)).toBe(202);
	return body.session_id as string;
}

// Sends, waits for the worker, approves like the operator, and returns the session row.
async function shift(context: APIRequestContext, faces: string[], extra: Extra = {}) {
	const id = await send(context, faces, extra);
	await waitForSession(id, ['review']);
	const approved = await approve(context, id);
	expect(approved.status(), await approved.text()).toBe(200);
	return sessionRow(id);
}

// Each gang card shows its start photo and faces as real, decoded pictures (not broken images).
async function expectPicturesLoaded(cards: Locator, photos: number, faces: number) {
	const loaded = (images: Locator) =>
		images.evaluateAll(
			(list) =>
				list.filter(
					(img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0
				).length
		);
	await expect.poll(() => loaded(cards.getByTestId('gang-start-photo'))).toBe(photos);
	await expect.poll(() => loaded(cards.getByTestId('gang-face'))).toBe(faces);
}

async function sessionRow(id: string) {
	const { rows } = await db.query('SELECT * FROM attendance_sessions WHERE id = $1', [id]);
	return rows[0];
}

async function dayCounts(pumpId: string, day = todayIST()) {
	const { rows } = await db.query(
		`SELECT count(*) FILTER (WHERE morning_matched AND evening_matched)::int AS full,
		        count(*) FILTER (WHERE morning_matched AND NOT evening_matched)::int AS start_only,
		        count(*)::int AS rows
		 FROM daily_person_attendance WHERE pump_id = $1 AND session_date = $2`,
		[pumpId, day]
	);
	return rows[0] as { full: number; start_only: number; rows: number };
}

// The plant manager's headcount workbook (Headcount and Gangs sheets).
async function headcountBook(context: APIRequestContext) {
	const response = await context.get('/plant-manager/attendance/export?report=headcount');
	expect(response.status()).toBe(200);
	const book = new ExcelJS.Workbook();
	await book.xlsx.load((await response.body()) as unknown as ArrayBuffer);
	return book;
}

// Today's column in a headcount sheet (header row 5 is "<weekday>\n<day of month>").
function todayColumn(sheet: ExcelJS.Worksheet) {
	const day = Number(todayIST().slice(8));
	const header = sheet.getRow(5);
	for (let c = 1; c <= header.cellCount; c++) {
		const text = String(header.getCell(c).value ?? '');
		if (text.split('\n').at(-1) === String(day)) return c;
	}
	throw new Error(`no column for day ${day} in ${sheet.name}`);
}

function rowByLabel(sheet: ExcelJS.Worksheet, label: string) {
	let found: ExcelJS.Row | null = null;
	sheet.eachRow((row) => {
		if (!found && String(row.getCell(1).value ?? '').trim() === label) found = row;
	});
	if (!found) throw new Error(`no row "${label}" in ${sheet.name}`);
	return found as ExcelJS.Row;
}

async function shots(page: Page, name: string, widths: number[]) {
	for (const width of widths) {
		await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
		// The side menu slides away when the page narrows: wait until it has finished.
		await page.evaluate(
			() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
		);
		await page.waitForFunction(() =>
			document.getAnimations().every((a) => a.playState !== 'running')
		);
		await page.screenshot({ path: `${SHOTS}/gangs-${name}-${width}.png`, fullPage: true });
		await noSidewaysScroll(page, width);
	}
}

test('GANG-10 admin switches gangs on per Area and the same-day fraud check, both audited', async ({
	page
}) => {
	const admin = await createAdmin();
	const context = await login(admin.email);
	const area = await createArea();
	// The action saves the full list of ticked Areas: keep every Area already on, add this one.
	const { rows: on } = await db.query('SELECT id FROM areas WHERE gangs_enabled');
	const form = new URLSearchParams();
	for (const id of [...on.map((r) => r.id as string), area.areaId]) form.append('area', id);
	const saved = await context.post('/admin/settings?/gangAreas', {
		data: form.toString(),
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			accept: 'application/json',
			'x-sveltekit-action': 'true'
		}
	});
	expect((await saved.json()).type).toBe('success');
	expect(
		(await db.query('SELECT gangs_enabled FROM areas WHERE id = $1', [area.areaId])).rows[0]
			.gangs_enabled
	).toBe(true);

	const fraudOn = await action(context, '/admin/settings?/sameDayFraud', { on: 'true' });
	expect(fraudOn.type).toBe('success');
	expect(
		(await db.query(`SELECT value FROM app_settings WHERE key = 'same_day_fraud_check'`)).rows[0]
			.value
	).toBe('on');
	const fraudOff = await action(context, '/admin/settings?/sameDayFraud', { on: 'false' });
	expect(fraudOff.type).toBe('success');
	const { rows: audit } = await db.query(
		`SELECT action FROM admin_audit_log WHERE admin_id = $1
		   AND action IN ('update_gang_areas', 'set_same_day_fraud') ORDER BY created_at`,
		[admin.id]
	);
	expect(audit.map((r) => r.action)).toEqual([
		'update_gang_areas',
		'set_same_day_fraud',
		'set_same_day_fraud'
	]);

	await signIn(page, admin.email);
	await page.goto('/admin/settings');
	const section = page.getByTestId('gangs-section');
	await expect(section).toBeVisible();
	await expect(page.getByTestId('same-day-fraud-state')).toContainText(/off/i);
	await section.scrollIntoViewIfNeeded();
	await page.setViewportSize({ width: 1440, height: 900 });
	await section.screenshot({ path: `${SHOTS}/gangs-settings-1440.png` });
});

test('GANG-01 gangs off: the Area runs exactly as before', async ({ page }) => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const manager = await createPlantManager(plantId);
	const phone = await login(pump.email);
	const start = await shift(phone, ['off-a', 'off-b']);
	await shiftBack(start.id, GAP);
	const end = await shift(phone, ['off-a', 'off-b']);
	expect([start.gang_id, end.gang_id]).toEqual([null, null]);
	expect([start.gang_slot, end.gang_slot]).toEqual([1, 1]);
	expect(end.paired_session_id).toBe(start.id);
	expect(await dayCounts(pump.id)).toMatchObject({ full: 2, rows: 2 });
	const today = await (await phone.get('/api/attendance/today')).json();
	expect(today.gangs).toBe(1);
	expect(today.gang_shifts ?? []).toEqual([]);

	const pm = await login(manager.email);
	const book = await headcountBook(pm);
	expect(book.getWorksheet('Gangs')).toBeUndefined();
	await signIn(page, manager.email);
	await page.goto('/plant-manager/attendance');
	await expect(page.getByTestId('by-gang')).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Gangs' })).toHaveCount(0);
});

test('GANG-02 a one-gang pump keeps its numbers; its gang has the same headcount', async () => {
	const { areaId, plantId } = await gangsArea();
	const pump = await createPump(plantId);
	const manager = await createPlantManager(plantId);
	const phone = await login(pump.email);
	const start = await shift(phone, ['one-a', 'one-b', 'one-c']);
	await shiftBack(start.id, GAP);
	const end = await shift(phone, ['one-a', 'one-b', 'one-c']);
	expect(start.gang_id).toBeTruthy();
	expect(end.gang_id).toBe(start.gang_id);
	expect([start.gang_slot, end.gang_slot]).toEqual([1, 1]);
	expect(await dayCounts(pump.id)).toMatchObject({ full: 3, start_only: 0, rows: 3 });
	const { rows: gangs } = await db.query(
		'SELECT code, source_session_id, first_pump_id FROM gangs WHERE area_id = $1',
		[areaId]
	);
	expect(gangs).toHaveLength(1);
	expect(gangs[0]).toMatchObject({ source_session_id: start.id, first_pump_id: pump.id });

	const book = await headcountBook(await login(manager.email));
	const pumpSheet = book.getWorksheet('Headcount')!;
	const gangSheet = book.getWorksheet('Gangs')!;
	expect(rowByLabel(pumpSheet, pump.code).getCell(todayColumn(pumpSheet)).value).toBe(3);
	const col = todayColumn(gangSheet);
	expect(rowByLabel(gangSheet, `Gang ${gangs[0].code}`).getCell(col).value).toBe(3);
	expect(rowByLabel(gangSheet, 'Difference').getCell(col).value).toBe(0);
});

test('GANG-06/07 a gang that moves pumps the same day counts once; fraud only when switched on', async ({
	page
}) => {
	const { areaId, plantId } = await gangsArea();
	const pump1 = await createPump(plantId);
	const pump2 = await createPump(plantId);
	const manager = await createPlantManager(plantId);
	const crew = ['move-a', 'move-b', 'move-c'];
	const phone1 = await login(pump1.email);
	const phone2 = await login(pump2.email);
	const start1 = await shift(phone1, crew);
	await shiftBack(start1.id, GAP);
	await shift(phone1, crew);
	// Fraud check off (the default): the same faces at the next pump are the same gang, no flag.
	const start2 = await shift(phone2, crew);
	expect(start2.gang_id).toBe(start1.gang_id);
	expect(
		(
			await db.query('SELECT count(*)::int AS n FROM fraud_flags WHERE session_id = $1', [
				start2.id
			])
		).rows[0].n
	).toBe(0);
	await shiftBack(start2.id, GAP);
	await shift(phone2, crew);
	// The pumps keep their own numbers: 3 at each.
	expect(await dayCounts(pump1.id)).toMatchObject({ full: 3 });
	expect(await dayCounts(pump2.id)).toMatchObject({ full: 3 });
	// Each worker is one area worker across both pumps.
	const { rows: workers } = await db.query(
		`SELECT count(DISTINCT COALESCE(p.area_worker_id, p.id))::int AS n
		 FROM daily_person_attendance d JOIN persons p ON p.id = d.person_id
		 WHERE d.pump_id = ANY($1::uuid[]) AND d.session_date = $2`,
		[[pump1.id, pump2.id], todayIST()]
	);
	expect(workers[0].n).toBe(3);

	// Gangs sheet against the database: the gang counts 3 (once a day), the pump sheet 6.
	const book = await headcountBook(await login(manager.email));
	const sheet = book.getWorksheet('Gangs')!;
	const col = todayColumn(sheet);
	const { rows: gang } = await db.query('SELECT code FROM gangs WHERE id = $1', [start1.gang_id]);
	expect(rowByLabel(sheet, `Gang ${gang[0].code}`).getCell(col).value).toBe(workers[0].n);
	expect(rowByLabel(sheet, `at ${pump1.code}`).getCell(col).value).toBe(3);
	expect(rowByLabel(sheet, `at ${pump2.code}`).getCell(col).value).toBe(3);
	expect(rowByLabel(sheet, 'All gangs (each worker once a day)').getCell(col).value).toBe(3);
	expect(rowByLabel(sheet, 'Pump sheet, same pumps').getCell(col).value).toBe(6);
	expect(rowByLabel(sheet, 'Difference').getCell(col).value).toBe(3);

	// The 9 am email: each pump's gang line names the other pump it worked at that day.
	const lines = await digestGangs(db, todayIST(), areaId);
	expect(lines.get(pump1.id)).toEqual([
		expect.objectContaining({ code: gang[0].code, people: 3, also: [pump2.code] })
	]);
	expect(gangLine(lines.get(pump2.id)!)).toContain(`also at ${pump1.code} that day`);

	// Attendance page, By gang: one row for the gang, 3 today, plus the total row.
	await signIn(page, manager.email);
	await page.goto('/plant-manager/attendance');
	await page.getByTestId('by-gang').click();
	const grid = page.getByTestId('gang-grid');
	await expect(grid).toBeVisible();
	await expect(grid.getByRole('link', { name: new RegExp(`Gang ${gang[0].code}`) })).toBeVisible();
	await expect(grid.locator('td', { hasText: /^3$/ }).first()).toBeVisible();
	await shots(page, 'pm-attendance-by-gang', [390, 1440]);

	// Fraud check switched on: the same crew at a third pump the same day is flagged.
	await fraudCheck(true);
	const pump3 = await createPump(plantId);
	const flagged = await send(await login(pump3.email), crew);
	await waitForSession(flagged, ['review', 'completed', 'fraud_detected', 'failed']);
	expect(
		(await db.query('SELECT count(*)::int AS n FROM fraud_flags WHERE session_id = $1', [flagged]))
			.rows[0].n
	).toBeGreaterThan(0);
});

test('GANG-05 two gangs at one pump: picker on the phone, the faces decide a wrong tap', async ({
	page
}) => {
	const { plantId } = await gangsArea();
	const pump = await createPump(plantId);
	const manager = await createPlantManager(plantId);
	const pm = await login(manager.email);
	const today = todayIST();
	const ticked = await action(pm, '/plant-manager/pump-status?/setStatus', {
		pump: pump.id,
		day: today,
		status: 'active',
		gangs_set: '1',
		gangs: '2'
	});
	expect(ticked.type, JSON.stringify(ticked)).toBe('success');

	const phone = await login(pump.email);
	const gangA = ['two-a1', 'two-a2', 'two-a3'];
	const gangB = ['two-b1', 'two-b2'];
	const pictureA = {
		image: 'gang-a-start.jpg',
		crops: ['face-man_33.jpg', 'face-man_36.jpg', 'face-man_38.jpg']
	};
	const pictureB = { image: 'gang-b-start.jpg', crops: ['face-woman_72.jpg', 'face-woman_75.jpg'] };
	const startA = await shift(phone, gangA, pictureA);
	expect(startA.gang_slot).toBe(1);

	// The phone at 390 px: the running shift and "New gang starting".
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, pump.email);
	await page.goto('/pump');
	await expect(page.getByTestId('gang-picker')).toBeVisible();
	await expect(page.getByTestId('gang-shift')).toHaveCount(1);
	await expect(page.getByTestId('gang-new')).toBeVisible();
	// The operator picks by picture: the start group photo and every face actually load.
	await expectPicturesLoaded(page.getByTestId('gang-shift'), 1, 3);
	// Shift details follow the pick: "New gang" (the only choice now) shows no start, only "start".
	await expect(page.getByTestId('details-started')).toHaveCount(0);
	await expect(page.getByTestId('operator-photo')).toBeVisible();
	const startStep = await page.getByTestId('next-step').innerText();
	await shots(page, 'pump-picker-one-running', [390]);

	const startB = await shift(phone, gangB, { shift: 'new', ...pictureB });
	expect(startB.gang_slot).toBe(2);
	expect(startB.gang_id).toBeTruthy();
	expect(startB.gang_id).not.toBe(startA.gang_id);
	const state = await (await phone.get('/api/attendance/today')).json();
	expect(state.gangs).toBe(2);
	expect(state.gang_shifts).toHaveLength(2);
	expect(state.can_start_gang).toBe(false);
	// The number on each card counts every face shown on it, the operator included (user, 2026-11-23).
	for (const card of state.gang_shifts) expect(card.people).toBe(card.faces.length);

	// Gang 1 an hour earlier, so the two cards' start times differ on screen.
	await shiftBack(startA.id, GAP + 60);
	await shiftBack(startB.id, GAP);
	await page.reload();
	await expect(page.getByTestId('gang-shift')).toHaveCount(2);
	await expect(page.getByTestId('gang-new')).toHaveCount(0);
	await expectPicturesLoaded(page.getByTestId('gang-shift'), 2, 5);
	// No photo step until a gang is picked (user, 2026-11-25): the operator finds the gang first.
	await expect(page.getByTestId('operator-photo')).toHaveCount(0);
	// Tapping a gang's photo chooses it: only that gang stays on screen, ticked, and the photo step
	// appears (user, 2026-11-25). "Change gang" brings both back and hides the photo step again.
	await page.getByTestId('gang-start-photo').nth(1).click();
	await expect(page.getByTestId('gang-shift')).toHaveCount(1);
	await expect(page.getByTestId('gang-shift').locator('.gang-tick')).toBeVisible();
	await expect(page.getByTestId('operator-photo')).toBeVisible();
	// The details show the picked gang's own start and "end"; picking the other gang changes the start.
	const endStep = await page.getByTestId('next-step').innerText();
	expect(endStep).not.toBe(startStep);
	const gang2Started = await page.getByTestId('details-started').innerText();
	await page.getByTestId('gang-change').click();
	await expect(page.getByTestId('gang-shift')).toHaveCount(2);
	await expect(page.getByTestId('operator-photo')).toHaveCount(0);
	await page.getByTestId('gang-start-photo').nth(0).click();
	await expect(page.getByTestId('details-started')).not.toHaveText(gang2Started);
	await expect(page.getByTestId('next-step')).toHaveText(endStep);
	await page.getByTestId('gang-change').click();
	await page.getByTestId('gang-start-photo').nth(1).click();
	await expect(page.getByTestId('details-started')).toHaveText(gang2Started);
	await page.evaluate(() => {
		(document.activeElement as HTMLElement | null)?.blur();
		window.scrollTo(0, 0);
	});
	await shots(page, 'pump-picker-two-ends-open', [390]);

	// Wrong tap: gang B's faces sent as gang A's end. The faces win: it ends gang B.
	const endB = await shift(phone, gangB, { shift: startA.id });
	expect(endB.paired_session_id).toBe(startB.id);
	expect(endB.gang_id).toBe(startB.gang_id);
	expect((await sessionRow(startA.id)).pairing_status).toBe('open');
	const endA = await shift(phone, gangA, { shift: startA.id });
	expect(endA.paired_session_id).toBe(startA.id);
	expect(await dayCounts(pump.id)).toMatchObject({ full: 5, start_only: 0, rows: 5 });
	expect(
		(
			await db.query('SELECT gangs FROM pump_day_status WHERE pump_id = $1 AND day = $2', [
				pump.id,
				today
			])
		).rows[0].gangs
	).toBe(2);
});

// User decision 2026-11-23: only the shift start is checked for location. A gang that moved sends
// its end from the first pump's login while standing at the next pump; that end counts at once.
test('GANG-04 a shift end sent far from the pump counts at once; nobody is asked', async ({
	page
}) => {
	const { plantId } = await gangsArea({ locationCheck: true });
	const pump1 = await createPump(plantId);
	const pump2 = await createPump(plantId);
	const manager = await createPlantManager(plantId);
	await setPumpGps(pump1, PUMP);
	await setPumpGps(pump2, FAR);
	const phone = await login(pump1.email);
	const crew = ['end-a', 'end-b', 'end-c'];
	// The start is still checked: near the pump, so it counts.
	const start = await shift(phone, crew, { at: NEAR });
	expect(start.location_status).toBe('ok');
	await shiftBack(start.id, GAP);
	// The end, 520 m away at the next pump: not checked, not held, a full shift straight away.
	const end = await shift(phone, crew, { at: FAR });
	expect(end.location_status).toBeNull();
	expect(end.location_ask_at).toBeNull();
	expect(end.paired_session_id).toBe(start.id);
	expect(await dayCounts(pump1.id)).toMatchObject({ full: 3, start_only: 0 });

	// Nothing waits for the plant manager, and the Gangs sheet day is a plain count (not amber).
	await signIn(page, manager.email);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/plant-manager/approvals');
	await expect(page.locator(`a[href$="/plant-manager/approvals/${end.id}"]`)).toHaveCount(0);
	const sheet = (await headcountBook(await login(manager.email))).getWorksheet('Gangs')!;
	const { rows: gang } = await db.query('SELECT code FROM gangs WHERE id = $1', [start.gang_id]);
	const cell = rowByLabel(sheet, `Gang ${gang[0].code}`).getCell(todayColumn(sheet));
	expect(cell.value).toBe(3);
	expect((cell.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb).not.toBe('FFFFE3A3');
	const admin = await login((await createAdmin()).email);
	expect(await (await admin.get(`/admin/gangs/${start.gang_id}`)).text()).not.toContain(
		'waiting for approval'
	);
});

test('GANG-08 a shift counted for the wrong gang is moved, start and end, and audited', async ({
	page
}) => {
	const { areaId, plantId } = await gangsArea();
	const pump = await createPump(plantId);
	const phone = await login(pump.email);
	const start = await shift(phone, ['wrong-a', 'wrong-b']);
	await shiftBack(start.id, GAP);
	const end = await shift(phone, ['wrong-a', 'wrong-b']);
	const adminRow = await createAdmin();
	const admin = await login(adminRow.email);

	// Desktop screenshots of the Gangs list and the gang page before the move.
	await signIn(page, adminRow.email);
	await page.goto(`/admin/gangs?q=${pump.code}`);
	await expect(page.getByTestId('gang-row').first()).toBeVisible();
	await shots(page, 'admin-list', [1440, 390]);
	await page.goto(`/admin/gangs/${start.gang_id}`);
	await expect(page.getByTestId('gang-shift-row')).toHaveCount(1);
	await expect(page.getByTestId('gang-day-headcount')).toHaveText('2');
	// The operator is one of the 2 counted, so a member too (labelled), never 2 counted / 1 member.
	await expect(page.getByTestId('gang-member')).toHaveCount(2);
	await expect(page.getByTestId('gang-member').filter({ hasText: 'Operator' })).toHaveCount(1);
	await shots(page, 'admin-gang-page', [1440, 390]);
	await page.goto(`/admin/attendance?area=${areaId}`);
	await page.getByTestId('by-gang').click();
	await expect(page.getByTestId('gang-grid')).toBeVisible();
	await shots(page, 'admin-attendance-by-gang', [1440]);

	const moved = await action(admin, `/admin/gangs/${start.gang_id}?/move`, {
		shift: start.id,
		gang: 'new'
	});
	expect(moved.type, JSON.stringify(moved)).toBe('success');
	const [s, e] = [await sessionRow(start.id), await sessionRow(end.id)];
	expect(s.gang_id).not.toBe(start.gang_id);
	expect(e.gang_id).toBe(s.gang_id);
	const { rows: audit } = await db.query(
		`SELECT target_id, details FROM admin_audit_log WHERE action = 'move_shift_gang' AND admin_id = $1`,
		[adminRow.id]
	);
	expect(audit).toHaveLength(1);
	expect(audit[0].target_id).toBe(start.id);
	expect(audit[0].details).toMatchObject({ pump: pump.code, from_gang: 1, to_gang: 2 });
	// Attendance itself is untouched by the move.
	expect(await dayCounts(pump.id)).toMatchObject({ full: 2 });
});

test('GANG-09 a close-call face at another pump is asked as "Same person?", plant manager links it', async ({
	page
}) => {
	const { plantId } = await gangsArea();
	const pump1 = await createPump(plantId);
	const pump2 = await createPump(plantId);
	const manager = await createPlantManager(plantId);
	await shift(await login(pump1.email), ['link-a', 'link-b', 'link-c']);
	// 0.33: above the match threshold (0.28) but below the clear-link bar (0.40).
	const group = await photo([{ identity: 'link-a', similarity: 0.33 }, 'link-n1', 'link-n2']);
	const phone2 = await login(pump2.email);
	const response = await phone2.post('/api/attendance/submit', {
		multipart: {
			photo: { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: group },
			operator_photo: {
				name: 'operator.jpg',
				mimeType: 'image/jpeg',
				buffer: await photo(['link-n1'])
			}
		}
	});
	const body = await response.json();
	expect(response.status(), JSON.stringify(body)).toBe(202);
	await waitForSession(body.session_id, ['review']);
	// Asked only once the pump approved the photo (a Retry would throw the new workers away).
	const approved = await approve(phone2, body.session_id);
	expect(approved.status(), await approved.text()).toBe(200);
	const { rows: open } = await db.query(
		`SELECT c.id, c.person_id, c.other_person_id FROM worker_link_candidates c
		 JOIN persons p ON p.id = c.person_id WHERE p.pump_id = $1 AND c.status = 'open'`,
		[pump2.id]
	);
	expect(open).toHaveLength(1);

	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, manager.email);
	await page.goto('/plant-manager/gangs');
	await expect(page.getByTestId('link-question')).toHaveCount(1);
	await shots(page, 'pm-same-person', [390, 1440]);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByTestId('link-same').click();
	await expect(page.getByTestId('link-question')).toHaveCount(0);
	const { rows: linked } = await db.query(
		'SELECT area_worker_id FROM persons WHERE id = ANY($1::uuid[])',
		[[open[0].person_id, open[0].other_person_id]]
	);
	expect(linked[0].area_worker_id).toBeTruthy();
	expect(linked[1].area_worker_id).toBe(linked[0].area_worker_id);
	expect(
		(await db.query('SELECT status FROM worker_link_candidates WHERE id = $1', [open[0].id]))
			.rows[0].status
	).toBe('linked');
});
