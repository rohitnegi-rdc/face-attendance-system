// LOC: shift start location check. In an area with the check on, the operator's phone must be
// within 100 m of the pump's latest GPS reading (at most 30 minutes old). Otherwise the shift
// starts on hold, the plant manager approves or rejects it on /plant-manager/approvals. The
// reports show a held day, marked, and leave it out of their counts until it is approved.
import { test, expect, type APIRequestContext } from '@playwright/test';
import ExcelJS from 'exceljs';
import {
	approve,
	action,
	anonymous,
	BASE_URL,
	createAdmin,
	createArea,
	createPlantManager,
	createPump,
	db,
	defaultOperatorPhoto,
	login,
	logLines,
	photo,
	recordSession,
	shiftBack,
	waitForSession,
	type Pump
} from './helpers';
import { loadHoldFacts, renderLocationEmail } from '../../worker/locationHold.js';

// A point in Mumbai and points ~40 m and ~520 m north of it.
const PUMP = { lat: 19.0596, lng: 72.9165 };
const NEAR = { lat: 19.05996, lng: 72.9165 };
const FAR = { lat: 19.06428, lng: 72.9165 };

async function checkedArea() {
	const area = await createArea();
	await db.query('UPDATE areas SET location_check_enabled = true WHERE id = $1', [area.areaId]);
	return area;
}

async function setPumpGps(pump: Pump, minutesAgo = 1, at = PUMP) {
	await db.query(
		`INSERT INTO pump_locations (pump_id, lat, lng, recorded_at, source)
		 VALUES ($1, $2, $3, now() - make_interval(mins => $4), 'gps_api')`,
		[pump.id, at.lat, at.lng, minutesAgo]
	);
}

async function startShift(
	context: APIRequestContext,
	phone: { lat: number; lng: number } | null,
	faces = ['loc-a']
) {
	const group = await photo(faces);
	const multipart: Record<string, any> = {
		photo: { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: group },
		operator_photo: {
			name: 'operator.jpg',
			mimeType: 'image/jpeg',
			buffer: await defaultOperatorPhoto(group)
		}
	};
	if (phone) {
		multipart.lat = String(phone.lat);
		multipart.lng = String(phone.lng);
	}
	const response = await context.post('/api/attendance/submit', { multipart });
	const body = await response.json();
	expect(response.status(), JSON.stringify(body)).toBe(202);
	const session = await waitForSession(body.session_id, ['review']);
	await approve(context, body.session_id);
	return { body, session };
}

// The pump's Daily sheet results and its headcount cells: the day's count, its fill and note,
// and the month average (null while every day is held).
async function reportFor(context: APIRequestContext, pumpCode: string) {
	const load = async (url: string) => {
		const response = await context.get(url);
		expect(response.status()).toBe(200);
		const book = new ExcelJS.Workbook();
		await book.xlsx.load((await response.body()) as any);
		return book;
	};
	const ws = (await load('/plant-manager/attendance/export')).getWorksheet('Daily')!;
	const header = (ws.getRow(1).values as any[]).slice(1);
	const pumpCol = header.indexOf('Pump') + 1;
	const resultCol = header.indexOf('Day result') + 1;
	const results: string[] = [];
	ws.eachRow((row, i) => {
		if (i > 1 && row.getCell(pumpCol).value === pumpCode)
			results.push(String(row.getCell(resultCol).value));
	});

	const sheet = (await load('/plant-manager/attendance/export?report=headcount')).getWorksheet(
		'Headcount'
	)!;
	const columns = sheet.getRow(5).cellCount;
	type Cells = { count: unknown; fill: unknown; note: string | null; avgMtd: unknown };
	// Assigned inside the eachRow callback, so the cast keeps TypeScript from narrowing to null.
	let headcount = null as Cells | null;
	sheet.eachRow((row) => {
		if (row.getCell(1).value !== pumpCode) return;
		for (let c = 4; c <= columns - 2; c++) {
			const cell = row.getCell(c);
			if (typeof cell.value === 'number') {
				const avg = row.getCell(columns - 1).value;
				headcount = {
					count: cell.value,
					fill: (cell.fill as any)?.fgColor?.argb ?? null,
					note:
						typeof cell.note === 'object'
							? (cell.note.texts ?? []).map((t) => t.text).join('')
							: (cell.note ?? null),
					avgMtd: avg === '-' ? null : avg
				};
			}
		}
	});
	return { results, headcount };
}

test('LOC-01 area without the check: no location status at all', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const { body, session } = await startShift(await login(pump.email), null);
	expect(body.location_hold).toBeNull();
	expect(session.location_status).toBeNull();
});

test('LOC-13 the shift card links each photo to its location on Google Maps, or says there is none', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const context = await login(pump.email);
	const { body } = await startShift(context, NEAR);
	await shiftBack(body.session_id, 600);
	const end = await recordSession(context, ['loc-a']);
	await db.query('UPDATE attendance_sessions SET gps_lat = $2, gps_lng = $3 WHERE id = $1', [
		end,
		FAR.lat,
		FAR.lng
	]);
	const noLocation = await createPump(plantId);
	await startShift(await login(noLocation.email), null, ['loc-b']);

	const manager = await login((await createPlantManager(plantId)).email);
	const admin = await login((await createAdmin()).email);
	const pages = [
		await (await manager.get('/plant-manager/attendance')).text(),
		await (await admin.get(`/admin/pumps/${pump.id}`)).text()
	];
	for (const page of pages) {
		expect(page).toContain(`https://www.google.com/maps?q=${NEAR.lat},${NEAR.lng}`);
		expect(page).toContain(`https://www.google.com/maps?q=${FAR.lat},${FAR.lng}`);
		expect(page).toContain('Shift start location on Google Maps');
		expect(page).toContain('Shift end location on Google Maps');
	}
	expect(pages[0]).toContain('data-testid="shift-no-location"');

	// A photo sent on another day than its shift shows the weekday, not the start of the date.
	await db.query(
		`UPDATE attendance_sessions SET submitted_at = '2026-11-02T18:06:00Z' WHERE id = $1`,
		[body.session_id]
	);
	const log = await (await manager.get('/plant-manager/attendance')).text();
	expect(log).toMatch(/Mon 11:36.pm/);
	expect(log).not.toMatch(/\d\d- \d/);
});

test('LOC-02 within 100 m of fresh pump GPS starts normally', async () => {
	const { plantId } = await checkedArea();
	const pump = await createPump(plantId);
	await setPumpGps(pump);
	const { body, session } = await startShift(await login(pump.email), NEAR);
	expect(body.location_hold).toBeNull();
	expect(session.location_status).toBe('ok');
	expect(session.location_distance_m).toBeLessThanOrEqual(100);
});

test('LOC-03 each missing or failed check is held with its own reason', async () => {
	const cases: { issue: string; phone: typeof PUMP | null; gpsMinutesAgo: number | null }[] = [
		{ issue: 'too_far', phone: FAR, gpsMinutesAgo: 1 },
		{ issue: 'no_phone_location', phone: null, gpsMinutesAgo: 1 },
		{ issue: 'no_pump_gps', phone: NEAR, gpsMinutesAgo: null },
		{ issue: 'stale_pump_gps', phone: NEAR, gpsMinutesAgo: 45 }
	];
	for (const c of cases) {
		const { plantId } = await checkedArea();
		const pump = await createPump(plantId);
		if (c.gpsMinutesAgo !== null) await setPumpGps(pump, c.gpsMinutesAgo);
		const { body, session } = await startShift(await login(pump.email), c.phone);
		expect(session.location_status, c.issue).toBe('pending');
		expect(session.location_issue, c.issue).toBe(c.issue);
		expect(body.location_hold, c.issue).toBeTruthy();
		if (c.issue === 'too_far') {
			expect(session.location_distance_m).toBeGreaterThan(400);
			expect(body.location_hold).toContain(`${session.location_distance_m} m`);
		}
		// The shift still started: the morning row exists and is open for the end photo.
		expect(session.pairing_status).toBe('open');
	}
});

test('LOC-04 plant manager approves; held day is shown marked and counted only after', async () => {
	const { plantId } = await checkedArea();
	const pump = await createPump(plantId);
	await setPumpGps(pump);
	const manager = await createPlantManager(plantId);
	const { session } = await startShift(await login(pump.email), FAR, ['loc-b', 'loc-c']);
	const pm = await login(manager.email);

	const list = await pm.get('/plant-manager/approvals');
	expect(await list.text()).toContain(pump.code);
	const page = await pm.get(`/plant-manager/approvals/${session.id}`);
	expect(page.status()).toBe(200);

	// Bug: the held day vanished from both Excel files ("-" = no photo sent), although the
	// screen grid showed it. It is shown, marked, and left out of counts until approved.
	const held = await reportFor(pm, pump.code);
	expect(held.results).toEqual(['Location pending', 'Location pending']);
	expect(held.headcount).toMatchObject({ count: 2, fill: 'FFFFE3A3', avgMtd: null });
	expect(held.headcount!.note).toContain('waiting for the plant manager');
	const approved = await action(pm, `/plant-manager/approvals/${session.id}?/approve`, {
		note: 'Called operator, new site'
	});
	expect(approved.type, JSON.stringify(approved)).toBe('success');
	const { rows } = await db.query('SELECT * FROM attendance_sessions WHERE id = $1', [session.id]);
	expect(rows[0].location_status).toBe('approved');
	expect(rows[0].location_decided_by).toBe(manager.id);
	const after = await reportFor(pm, pump.code);
	expect(after.results).toEqual(['Shift still open', 'Shift still open']);
	expect(after.headcount).toMatchObject({ count: 2, note: null, avgMtd: 2 });

	// A second decision is refused, not silently overwritten.
	const again = await action(pm, `/plant-manager/approvals/${session.id}?/reject`, { note: 'x' });
	expect(again.status).toBe(409);
});

test('LOC-05 reject needs a note; the day is shown as rejected and not counted', async () => {
	const { plantId } = await checkedArea();
	const pump = await createPump(plantId);
	const manager = await createPlantManager(plantId);
	const { session } = await startShift(await login(pump.email), null);
	const pm = await login(manager.email);

	const noNote = await action(pm, `/plant-manager/approvals/${session.id}?/reject`, { note: '' });
	expect(noNote.status).toBe(400);
	const rejected = await action(pm, `/plant-manager/approvals/${session.id}?/reject`, {
		note: 'Operator was at home'
	});
	expect(rejected.type).toBe('success');
	const report = await reportFor(pm, pump.code);
	expect(report.results).toEqual(['Location rejected']);
	expect(report.headcount).toMatchObject({ count: 1, fill: 'FFF8C4C4', avgMtd: null });
});

test('LOC-06 only the plant manager of that plant sees it; login returns to the link', async () => {
	const { plantId } = await checkedArea();
	const pump = await createPump(plantId);
	const { session } = await startShift(await login(pump.email), null);
	const other = await createPlantManager((await createArea()).plantId);
	const stranger = await login(other.email);
	expect((await stranger.get(`/plant-manager/approvals/${session.id}`)).status()).toBe(404);
	const denied = await action(stranger, `/plant-manager/approvals/${session.id}?/approve`, {
		note: ''
	});
	expect(denied.httpStatus).toBe(404);

	const anon = await anonymous();
	const redirect = await anon.get(`/plant-manager/approvals/${session.id}`, { maxRedirects: 0 });
	expect(redirect.status()).toBe(302);
	expect(redirect.headers().location).toContain(
		`next=${encodeURIComponent(`/plant-manager/approvals/${session.id}`)}`
	);
});

// A monitor of the Area (plant-manager login with is_monitor, no plant of its own).
async function monitorOf(areaId: string) {
	const other = await createArea();
	const monitor = await createPlantManager(other.plantId);
	await db.query('DELETE FROM plant_manager_assignments WHERE manager_id = $1', [monitor.id]);
	await db.query('UPDATE plant_managers SET is_monitor = true WHERE id = $1', [monitor.id]);
	await db.query('INSERT INTO monitor_areas (manager_id, area_id) VALUES ($1, $2)', [
		monitor.id,
		areaId
	]);
	return monitor;
}

// The location approval emails one held start got, from whichever worker asked (two run).
async function askedMails(sessionId: string, count: number) {
	let mails: Record<string, string>[] = [];
	await expect
		.poll(
			async () => {
				mails = [
					...(await logLines('worker-1', [sessionId, 'location approval email'], 0)),
					...(await logLines('worker-2', [sessionId, 'location approval email'], 0))
				];
				return mails.length;
			},
			{ timeout: 20_000 }
		)
		.toBeGreaterThanOrEqual(count);
	return mails.sort((a, b) => String(a.to).localeCompare(String(b.to)));
}

// 2026-11-18: "the Plant Manager is currently not getting the approval mail"; To: the plant's
// managers and the Area's monitors (they decide it), never an admin login. Later the same day: the
// email waits for the pump GPS first, and has Approve and Reject buttons, one email per person,
// each with their own link. A phone that shared no location is asked at once.
test('LOC-07 held shift emails the plant manager an absolute approval link', async () => {
	test.skip(!process.env.REGRESSION_OUTPUT_DIR, 'needs the worker log from run-regression');
	const admin = await login((await createAdmin()).email);
	expect((await action(admin, '/admin/settings?/approvalEmail', { on: 'true' })).type).toBe(
		'success'
	);
	try {
		const { areaId, plantId } = await checkedArea();
		const pump = await createPump(plantId);
		const manager = await createPlantManager(plantId);
		const monitor = await monitorOf(areaId);
		const elsewhere = await monitorOf((await createArea()).areaId);
		const { session } = await startShift(await login(pump.email), null);

		const mails = await askedMails(session.id, 2);
		await new Promise((r) => setTimeout(r, 2_000));
		expect(await askedMails(session.id, 2)).toHaveLength(2); // asked once, not by both workers
		expect(mails.map((m) => m.message)).toEqual([
			'location approval email NOT sent (mail off)',
			'location approval email NOT sent (mail off)'
		]);
		expect(mails.map((m) => m.to).sort()).toEqual([manager.email, monitor.email].sort());
		expect(mails.map((m) => m.to)).not.toContain(elsewhere.email);
		// A made-up login (migration 026) has no mailbox.
		expect(mails.map((m) => m.to)).not.toContain('admin@attendance.rdc');
		for (const mail of mails) {
			expect(mail.subject).toBe(`Please decide: ${pump.code} shift start, place not confirmed`);
			// Regression: a link was once built as "<origin>../../plant-manager/...".
			expect(mail.approveUrl).toMatch(new RegExp(`^${BASE_URL}/location/[^/?]+\\?do=approve$`));
			expect(mail.rejectUrl).toBe(mail.approveUrl.replace('do=approve', 'do=reject'));
		}
		expect(mails[0].approveUrl).not.toBe(mails[1].approveUrl);
		const { rows } = await db.query(
			'SELECT location_asked_at FROM attendance_sessions WHERE id = $1',
			[session.id]
		);
		expect(rows[0].location_asked_at).not.toBeNull();
	} finally {
		await db.query(`DELETE FROM app_settings WHERE key = 'location_approval_email'`);
	}
});

test('LOC-12 approval emails are off by default; the shift still waits for approval', async () => {
	test.skip(!process.env.REGRESSION_OUTPUT_DIR, 'needs the worker log from run-regression');
	const { plantId } = await checkedArea();
	const pump = await createPump(plantId);
	const manager = await createPlantManager(plantId);
	const { session } = await startShift(await login(pump.email), null);

	const mails = await askedMails(session.id, 1);
	expect(mails).toHaveLength(1);
	expect(mails[0].message).toBe('location approval email NOT sent (switched off)');
	expect(mails[0].to).toBe(manager.email);
	expect(session.location_status).toBe('pending');
});

test('LOC-11 in test mode a held shift is logged, not emailed, and still waits for approval', async () => {
	test.skip(!process.env.REGRESSION_OUTPUT_DIR, 'needs the worker log from run-regression');
	const admin = await login((await createAdmin()).email);
	expect((await action(admin, '/admin/settings?/testMode', { on: 'true' })).type).toBe('success');
	try {
		const { plantId } = await checkedArea();
		const pump = await createPump(plantId);
		const manager = await createPlantManager(plantId);
		const { session } = await startShift(await login(pump.email), null);

		const mails = await askedMails(session.id, 1);
		expect(mails).toHaveLength(1);
		expect(mails[0].message).toBe('location approval email NOT sent (test mode)');
		expect(mails[0].to).toBe(manager.email);
		// The plant manager still has it to approve in the app.
		const approvals = await (await login(manager.email)).get('/plant-manager/approvals');
		expect(await approvals.text()).toContain(pump.code);
	} finally {
		await db.query(`DELETE FROM app_settings WHERE key = 'test_mode'`);
	}
});

// The email's buttons open /location/<token>: opening decides nothing, the button on the page
// does; a rejection needs a reason; the link works only for the person it was sent to while they
// still look after the pump. Phone first (plant managers open it from the email on their phone).
test('LOC-18 the email link page approves or rejects a held start, phone first', async ({
	page
}) => {
	test.skip(!process.env.REGRESSION_OUTPUT_DIR, 'needs the worker log from run-regression');
	const { areaId, plantId } = await checkedArea();
	const pump = await createPump(plantId);
	const manager = await createPlantManager(plantId);
	const monitor = await monitorOf(areaId);
	const { session } = await startShift(await login(pump.email), null, ['loc-d', 'loc-e']);
	const mails = await askedMails(session.id, 2);
	const mine = mails.find((m) => m.to === manager.email)!;
	const theirs = mails.find((m) => m.to === monitor.email)!;
	const link = (url: string) => new URL(url).pathname + new URL(url).search;
	const base = (url: string) => new URL(url).pathname;

	// The email itself, as a phone shows it.
	const facts = await loadHoldFacts(db, session.id);
	const email = renderLocationEmail(
		{ ...facts, photo_cid: null },
		{ name: 'Sebastian Shine' },
		mine.approveUrl,
		mine.rejectUrl
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.setContent(email.html);
	await expect(page.getByRole('link', { name: 'Approve' })).toHaveAttribute(
		'href',
		mine.approveUrl
	);
	await expect(page.getByRole('link', { name: 'Reject' })).toHaveAttribute('href', mine.rejectUrl);
	await page.screenshot({
		path: 'artifacts/deep-build/screenshots/location-email-mobile.png'
	});

	// Opening the Reject button's link decides nothing.
	await page.goto(link(mine.rejectUrl));
	await expect(page.getByRole('heading', { level: 1 })).toContainText(pump.code);
	await expect(page.getByTestId('loc-link-why')).toContainText('did not share its location');
	await expect(page.getByRole('tab', { name: 'Reject' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('loc-link-reason')).toBeVisible();
	const photo = await page.request.get(`${base(mine.approveUrl)}/photo`);
	expect(photo.status()).toBe(200);
	expect(photo.headers()['content-type']).toBe('image/jpeg');
	expect(
		(await db.query('SELECT location_status FROM attendance_sessions WHERE id = $1', [session.id]))
			.rows[0].location_status
	).toBe('pending');
	const width = await page.evaluate(() => document.documentElement.scrollWidth);
	expect(width).toBeLessThanOrEqual(390);
	await page.screenshot({
		path: 'artifacts/deep-build/screenshots/location-link-mobile.png',
		fullPage: true
	});

	// A rejection without a reason is refused by the server too.
	const anon = await anonymous();
	const noReason = await action(anon, `${base(mine.rejectUrl)}?/reject`, {
		note: ''
	});
	expect(noReason.status).toBe(400);

	// Approve from the page.
	await page.getByRole('tab', { name: 'Approve' }).click();
	await page.getByLabel('Note (optional)').fill('Called the operator, new site');
	await page.getByTestId('loc-link-approve').click();
	await expect(page.getByTestId('loc-link-done')).toContainText('Approved');
	const { rows } = await db.query(
		`SELECT location_status, location_decided_by, location_note
		 FROM attendance_sessions WHERE id = $1`,
		[session.id]
	);
	expect(rows[0]).toEqual({
		location_status: 'approved',
		location_decided_by: manager.id,
		location_note: 'Called the operator, new site'
	});
	const decided = await logLines('app', [session.id, 'location approval decided']);
	expect(decided[0]).toMatchObject({
		managerId: manager.id,
		decision: 'approved',
		via: 'email'
	});

	// Opened again later: it says who decided, and offers no buttons.
	await page.goto(link(mine.approveUrl));
	await expect(page.getByTestId('loc-link-settled')).toContainText('Approved by');
	await expect(page.getByTestId('loc-link-approve')).toHaveCount(0);
	// The other person's link cannot overrule it.
	const late = await action(anon, `${base(theirs.rejectUrl)}?/reject`, {
		note: 'Too late'
	});
	expect(late.status).toBe(409);

	// A monitor who no longer watches the Area cannot use their link; a made-up link shows nothing.
	await db.query('DELETE FROM monitor_areas WHERE manager_id = $1', [monitor.id]);
	await page.goto(link(theirs.approveUrl));
	await expect(page.getByTestId('loc-link-not-yours')).toBeVisible();
	expect((await page.request.get(`${base(theirs.approveUrl)}/photo`)).status()).toBe(404);
	await page.goto('/location/not-a-real-token');
	await expect(page.getByTestId('loc-link-invalid')).toBeVisible();

	// Desktop: a fresh held start, open.
	const otherPump = await createPump(plantId); // the first pump's shift is still open
	const second = await startShift(await login(otherPump.email), null, ['loc-f']);
	const [desk] = (await askedMails(second.session.id, 1)).filter((m) => m.to === manager.email);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(link(desk.approveUrl));
	await expect(page.getByTestId('loc-link-approve')).toBeVisible();
	await page.screenshot({
		path: 'artifacts/deep-build/screenshots/location-link-desktop.png'
	});
});

// The wait before asking: a start away from the pump is held, the worker watches the pump GPS, and
// a reading near the photo spot approves it by itself, with no email. The plant manager meanwhile
// sees it under Checking pump GPS, not as waiting for them.
test('LOC-19 a held start clears by itself when the pump GPS reaches the photo spot', async () => {
	test.skip(!process.env.REGRESSION_OUTPUT_DIR, 'needs the workers from run-regression');
	const admin = await login((await createAdmin()).email);
	const saved = await action(admin, '/admin/settings?/locationHold', {
		minutes: '30'
	});
	expect(saved.type).toBe('success');
	try {
		const { plantId } = await checkedArea();
		const pump = await createPump(plantId);
		await setPumpGps(pump, 2, PUMP);
		const manager = await createPlantManager(plantId);
		const { session } = await startShift(await login(pump.email), FAR, ['loc-g']);
		expect(session.location_status).toBe('pending');
		expect(session.location_issue).toBe('too_far');
		const { rows: held } = await db.query(
			`SELECT round(extract(epoch FROM location_ask_at - submitted_at) / 60)::int AS wait,
			        location_asked_at FROM attendance_sessions WHERE id = $1`,
			[session.id]
		);
		expect(held[0]).toEqual({ wait: 30, location_asked_at: null });

		const pm = await login(manager.email);
		const list = await (await pm.get('/plant-manager/approvals')).text();
		expect(list).toContain('Checking pump GPS (1)');
		expect(list).toContain('Waiting for you (0)');

		// The pump drives to where the photo was taken.
		await setPumpGps(pump, 0, { lat: FAR.lat + 0.0003, lng: FAR.lng });
		await expect
			.poll(
				async () =>
					(
						await db.query('SELECT location_status FROM attendance_sessions WHERE id = $1', [
							session.id
						])
					).rows[0].location_status,
				{ timeout: 20_000 }
			)
			.toBe('approved');
		const { rows } = await db.query(
			`SELECT location_note, location_auto_cleared_at, location_asked_at, location_decided_by
			 FROM attendance_sessions WHERE id = $1`,
			[session.id]
		);
		expect(rows[0].location_note).toMatch(
			/^Cleared automatically: the pump GPS was \d+ m from the photo spot at /
		);
		expect(rows[0].location_auto_cleared_at).not.toBeNull();
		expect(rows[0].location_asked_at).toBeNull();
		expect(rows[0].location_decided_by).toBeNull();
		expect(await logLines('worker-1', [session.id, 'location approval email'], 0)).toHaveLength(0);
		expect(await logLines('worker-2', [session.id, 'location approval email'], 0)).toHaveLength(0);
		expect(await (await pm.get('/plant-manager/approvals')).text()).toContain('By the pump GPS');

		// The wait is audited and refuses nonsense.
		const bad = await action(admin, '/admin/settings?/locationHold', {
			minutes: '500'
		});
		expect(bad.status).toBe(400);
		const { rows: audit } = await db.query(
			`SELECT details FROM admin_audit_log WHERE action = 'set_location_hold'
			 ORDER BY created_at DESC LIMIT 1`
		);
		expect(audit[0].details).toEqual({ minutes: 30 });
	} finally {
		await db.query(`DELETE FROM app_settings WHERE key = 'location_hold_minutes'`);
	}
});
test('LOC-08 worker copies pump GPS from the feed, by pump code or GPS device id', async () => {
	test.skip(!process.env.REGRESSION_OUTPUT_DIR, 'needs the workers from run-regression');
	const { plantId } = await checkedArea();
	const byCode = await createPump(plantId);
	const byDevice = await createPump(plantId);
	const deviceId = `DEV-${byDevice.code}`;
	await db.query('UPDATE pumps SET gps_device_id = $1 WHERE id = $2', [deviceId, byDevice.id]);
	const unknown = `UNKNOWN-${byCode.code}`;

	const feed = (id: string, lat: string, lng: string, minutesAgo: number) =>
		db.query(
			`INSERT INTO dump.pump_events (pump_id, latitude, longitude, event_timestamp)
			 VALUES ($1, $2, $3, date_trunc('second', now()) - make_interval(mins => $4))`,
			[id, lat, lng, minutesAgo]
		);
	await feed(byCode.code.toLowerCase(), String(PUMP.lat), String(PUMP.lng), 2); // case-insensitive
	await feed(byCode.code, '', '', 1); // no fix: skipped
	await feed(byCode.code, '19.1', '72.9', 180); // older than the lookback: skipped
	await feed(deviceId, '19.0601', '72.9170', 3);
	await feed(unknown, '19.0', '72.9', 1);

	const rowsFor = async (pumpId: string) =>
		(
			await db.query(
				`SELECT lat, lng, source, now() - recorded_at AS age FROM pump_locations WHERE pump_id = $1`,
				[pumpId]
			)
		).rows;
	await expect.poll(async () => (await rowsFor(byCode.id)).length, { timeout: 20_000 }).toBe(1);
	await expect.poll(async () => (await rowsFor(byDevice.id)).length, { timeout: 20_000 }).toBe(1);
	const [reading] = await rowsFor(byCode.id);
	expect(reading.lat).toBe(PUMP.lat);
	expect(reading.lng).toBe(PUMP.lng);
	expect(reading.source).toBe('gps_api');
	expect((await rowsFor(byDevice.id))[0].lat).toBe(19.0601);
	// The unknown id is logged by whichever worker polled.
	await expect
		.poll(
			async () =>
				(await logLines('worker-1', unknown, 0)).length +
				(await logLines('worker-2', unknown, 0)).length,
			{ timeout: 20_000 }
		)
		.toBeGreaterThan(0);

	// The copied reading drives the check: the operator nearby starts normally.
	const { session } = await startShift(await login(byCode.email), NEAR);
	expect(session.location_status).toBe('ok');
});

// 2026-11-18: "Make sure that user's local[ion check] is also enabled in this process". An admin
// ticks the Areas that check the shift start location at /admin/settings (audited); a start sent
// away from the pump in a ticked Area waits for its plant manager, in an unticked one it does not.
test('LOC-17 an admin switches the location check per area; only a ticked area holds a far start', async ({
	page
}) => {
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(String(e)));
	page.on('console', (m) => {
		if (m.type() === 'error') problems.push(m.text());
	});
	const admin = await createAdmin();
	const { areaId, plantId } = await createArea();
	const { rows } = await db.query('SELECT name FROM areas WHERE id = $1', [areaId]);
	const areaName = rows[0].name as string;
	const { rows: before } = await db.query(
		'SELECT id FROM areas WHERE location_check_enabled ORDER BY name'
	);
	const pump = await createPump(plantId);
	await setPumpGps(pump);

	try {
		await page.setViewportSize({ width: 390, height: 844 });
		const { signIn, noSidewaysScroll } = await import('./regularisationHelpers');
		await signIn(page, admin.email);
		await page.goto('/admin/settings');
		const form = page.getByTestId('location-areas');
		const box = form.getByLabel(areaName, { exact: true });
		await expect(box).not.toBeChecked();
		await box.check();
		await form.getByRole('button', { name: 'Save areas' }).click();
		await expect(
			page.getByRole('status').filter({ hasText: 'location check is on' })
		).toContainText(areaName);
		await expect(page.getByTestId('location-areas-now')).toContainText(areaName);
		await page.reload();
		await expect(
			page.getByTestId('location-areas').getByLabel(areaName, { exact: true })
		).toBeChecked();
		await page.getByTestId('approval-email-section').scrollIntoViewIfNeeded();
		await noSidewaysScroll(page);
		await page
			.getByTestId('approval-email-section')
			.screenshot({ path: 'artifacts/deep-build/screenshots/location-areas-mobile.png' });
		const { rows: audit } = await db.query(
			`SELECT details FROM admin_audit_log WHERE action = 'update_location_areas'
			 ORDER BY created_at DESC LIMIT 1`
		);
		expect(audit[0].details.after).toContain(areaName);

		// Ticked: a start 520 m away waits for approval.
		const operator = await login(pump.email);
		const held = await startShift(operator, FAR);
		expect(held.session.location_status).toBe('pending');
		expect(held.body.location_hold).toContain('m from the pump');

		await page.setViewportSize({ width: 1280, height: 900 });
		await page.getByTestId('approval-email-section').scrollIntoViewIfNeeded();
		await page.screenshot({ path: 'artifacts/deep-build/screenshots/location-areas-desktop.png' });

		// Unticked: the next start is not checked at all.
		const untick = page.getByTestId('location-areas').getByLabel(areaName, { exact: true });
		await untick.uncheck();
		await page.getByTestId('location-areas').getByRole('button', { name: 'Save areas' }).click();
		await expect(page.getByTestId('location-areas-now')).not.toContainText(areaName);
		const { rows: off } = await db.query('SELECT location_check_enabled FROM areas WHERE id = $1', [
			areaId
		]);
		expect(off[0].location_check_enabled).toBe(false);
		const other = await createPump(plantId);
		const free = await startShift(await login(other.email), FAR, ['loc-free']);
		expect(free.session.location_status).toBeNull();
		expect(free.body.location_hold).toBeNull();
		expect(problems).toEqual([]);
	} finally {
		// Other scenarios rely on the areas they set; put back what was on before.
		await db.query('UPDATE areas SET location_check_enabled = (id = ANY($1::uuid[]))', [
			before.map((r) => r.id)
		]);
	}
});
