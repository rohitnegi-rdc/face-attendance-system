// REG: regularisation of a missed day (migration 048, src/lib/server/regularisation.ts). A pump that
// was Active or Idle on a past day but sent no photo asks for it to be counted, from the pump screen
// (or its plant manager does, for a broken phone). The plant's business manager approves or rejects
// it from the email's link or in the app; a plant without one goes to the admins; an admin can always
// decide, and undo. Emails are never sent here: mail is off, so each is a log line whose link the
// test opens like the approver would.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { digestPumpDays, digestPumps, groupPumps } from '../../worker/attendanceDigest.js';
import { renderAttendanceDigest } from '../../worker/digestEmail.js';
import {
	PASSWORD,
	STUB_URL,
	action,
	anonymous,
	createAdmin,
	createArea,
	createPlantManager,
	createPump,
	db,
	logLines,
	login
} from './helpers';

const todayIST = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
function daysAgo(n: number) {
	const [y, m, d] = todayIST().split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

// A pump Active since six days ago with three workers and no photo since: days 6..1 are missed.
async function missedPump() {
	const { areaId, plantId } = await createArea();
	const pump = await createPump(plantId);
	// The pump existed on the missed days (the 9 am email leaves out a pump added later).
	await db.query(`UPDATE pumps SET created_at = now() - interval '30 days' WHERE id = $1`, [
		pump.id
	]);
	const { rows } = await db.query(
		`INSERT INTO persons (pump_id, display_seq, name)
		 SELECT $1, n, 'Crew ' || n FROM generate_series(1, 3) n RETURNING id`,
		[pump.id]
	);
	// Only workers with a real attendance can be asked for (REG-11).
	for (const row of rows) {
		await db.query(
			`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched, evening_matched)
			 VALUES ($1, $2, $3, true, true)`,
			[row.id, pump.id, daysAgo(20)]
		);
	}
	await db.query(
		`INSERT INTO pump_day_status (pump_id, day, status, set_by_role, set_by_id, set_by_name)
		 VALUES ($1, $2, 'active', 'admin', $3, 'Regression')`,
		[pump.id, daysAgo(6), randomUUID()]
	);
	return { pump, areaId, plantId, workers: rows.map((r) => r.id as string) };
}

async function businessManager(plantId: string) {
	const email = `bm${randomUUID().slice(0, 8)}@regression.test`;
	const { rows } = await db.query(
		`INSERT INTO plant_managers (name, email, password_hash, must_change_password, is_business_manager)
		 VALUES ($1, $2, $3, FALSE, true) RETURNING id`,
		[`BM ${email.slice(2, 8)}`, email, await bcrypt.hash(PASSWORD, 4)]
	);
	await db.query('INSERT INTO business_manager_plants (plant_id, manager_id) VALUES ($1, $2)', [
		plantId,
		rows[0].id
	]);
	return { id: rows[0].id as string, email };
}

// The pump screen's Send: multipart with one `workers` field per ticked worker.
async function askFor(
	phone: APIRequestContext,
	day: string,
	workers: string[],
	reason = 'no_network',
	note = ''
) {
	const form = new FormData();
	form.set('day', day);
	form.set('reason', reason);
	if (note) form.set('note', note);
	for (const w of workers) form.append('workers', w);
	return phone.post('/api/pump/regularisation', { multipart: form });
}

async function requestMail(id: string, to: string) {
	let line: Record<string, string> | undefined;
	await expect
		.poll(async () => {
			const lines = await logLines('app', [id, 'regularisation email NOT sent (mail off)'], 0);
			line = lines.find((l) => l.to === to);
			return Boolean(line);
		})
		.toBe(true);
	return line as { to: string; subject: string; approveUrl: string; rejectUrl: string };
}

const pathOf = (url: string) => new URL(url).pathname;

async function status(id: string) {
	const { rows } = await db.query(
		'SELECT status, decision_reason FROM regularisations WHERE id = $1',
		[id]
	);
	return rows[0] as { status: string; decision_reason: string | null };
}

async function counted(id: string) {
	return (
		await db.query('SELECT 1 FROM daily_person_attendance WHERE regularisation_id = $1', [id])
	).rowCount;
}

async function signIn(page: Page, email: string) {
	await page.goto('/login');
	await page.getByTestId('login-email').fill(email);
	await page.getByTestId('login-password').fill(PASSWORD);
	await page.getByTestId('login-submit').click();
	await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function noSidewaysScroll(page: Page) {
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
}

test('REG-01 the pump asks for a missed day; the business manager approves from the email link and the day counts', async () => {
	const { pump, areaId, plantId, workers } = await missedPump();
	const bm = await businessManager(plantId);
	const phone = await login(pump.email);

	const state = await (await phone.get('/api/pump/regularisation')).json();
	expect(state.days).toEqual([1, 2, 3, 4, 5, 6].map(daysAgo));
	const day = daysAgo(2);
	expect((await (await phone.get(`/api/pump/regularisation?day=${day}`)).json()).crew).toHaveLength(
		3
	);

	const sent = await askFor(phone, day, workers.slice(0, 2));
	expect(sent.status(), await sent.text()).toBe(200);
	const { id, status: first } = await sent.json();
	expect(first).toBe('pending');

	const mail = await requestMail(id, bm.email);
	expect(mail.subject).toContain(pump.code);
	expect(mail.approveUrl).toContain('?do=approve');

	const after = await (await phone.get('/api/pump/regularisation')).json();
	expect(after.days).not.toContain(day);
	expect(after.requests.find((r: { id: string }) => r.id === id).status).toBe('pending');

	// Opening the link (as a mail scanner would) decides nothing.
	const browser = await anonymous();
	const opened = await browser.get(`${pathOf(mail.approveUrl)}?do=approve`);
	expect(opened.status()).toBe(200);
	const html = await opened.text();
	expect(html).toContain('data-testid="reg-facts"');
	expect(html).toContain(pump.code);
	expect((await status(id)).status).toBe('pending');

	const approved = await action(browser, `${pathOf(mail.approveUrl)}?/approve`, {});
	expect(approved.type, JSON.stringify(approved)).toBe('success');
	expect((await status(id)).status).toBe('approved');
	const { rows } = await db.query(
		`SELECT person_id FROM daily_person_attendance
		 WHERE pump_id = $1 AND session_date = $2 AND regularisation_id = $3
		   AND morning_matched AND evening_matched`,
		[pump.id, day, id]
	);
	expect(rows.map((r) => r.person_id).sort()).toEqual(workers.slice(0, 2).sort());
	const { rows: decided } = await db.query(
		`SELECT 1 FROM regularisations WHERE id = $1 AND decided_by_role = 'business_manager' AND decided_by_id = $2`,
		[id, bm.id]
	);
	expect(decided).toHaveLength(1);

	// The 9 am email counts the two workers for that day, marks the pump, and labels it Regularised.
	const pumps = await digestPumps(db, day, areaId);
	const row = pumps.find((p) => p.id === pump.id)!;
	expect(row.full_shift).toBe(2);
	expect(row.regularised).toBe(true);
	const mtd = await digestPumpDays(db, day, areaId);
	expect(mtd.marked).toBeGreaterThanOrEqual(1);
	const email = renderAttendanceDigest({ area: 'Area', day, ...groupPumps(pumps), mtd });
	expect(email.html).toContain('Regularised');

	// The pump sees it approved; the link now only says it is settled and cannot decide again.
	const final = await (await phone.get('/api/pump/regularisation')).json();
	expect(final.requests.find((r: { id: string }) => r.id === id).status).toBe('approved');
	const again = await (await anonymous()).get(pathOf(mail.approveUrl));
	expect(await again.text()).toContain('data-testid="reg-link-settled"');
	const twice = await action(await anonymous(), `${pathOf(mail.approveUrl)}?/approve`, {});
	expect(twice.type).toBe('failure');
	// A tampered link does nothing.
	const bad = await (await anonymous()).get(`${pathOf(mail.approveUrl)}x`);
	expect(await bad.text()).toContain('data-testid="reg-link-invalid"');
});

test('REG-02 the business manager rejects with a reason; the pump sees it and can ask again', async () => {
	const { pump, plantId, workers } = await missedPump();
	const bm = await businessManager(plantId);
	const phone = await login(pump.email);
	const day = daysAgo(3);
	const { id } = await (await askFor(phone, day, workers)).json();
	const mail = await requestMail(id, bm.email);

	const browser = await anonymous();
	const opened = await (await browser.get(`${pathOf(mail.rejectUrl)}?do=reject`)).text();
	expect(opened).toContain('data-testid="reg-link-reason"');
	const rejected = await action(browser, `${pathOf(mail.rejectUrl)}?/reject`, {
		reject_reason: 'wrong_crew',
		note: 'Crew 3 was on leave'
	});
	expect(rejected.type, JSON.stringify(rejected)).toBe('success');
	const row = await status(id);
	expect(row.status).toBe('rejected');
	expect(row.decision_reason).toContain('Crew 3 was on leave');
	expect(await counted(id)).toBe(0);

	const state = await (await phone.get('/api/pump/regularisation')).json();
	const seen = state.requests.find((r: { id: string }) => r.id === id);
	expect(seen.status).toBe('rejected');
	expect(seen.decisionReason).toContain('Crew 3 was on leave');
	expect(state.days).toContain(day);
	const second = await askFor(phone, day, workers.slice(0, 2), 'phone_problem');
	expect(second.status(), await second.text()).toBe(200);

	// Rejecting as Other needs a note.
	const { id: third } = await (await askFor(phone, daysAgo(4), workers)).json();
	const mail3 = await requestMail(third, bm.email);
	const noNote = await action(await anonymous(), `${pathOf(mail3.rejectUrl)}?/reject`, {
		reject_reason: 'other'
	});
	expect(noNote.type).toBe('failure');
	expect((await status(third)).status).toBe('pending');
});

test('REG-03 only past Active or Idle days without a photo, once each, with workers of the pump', async () => {
	const { pump, workers } = await missedPump();
	const other = await missedPump();
	const phone = await login(pump.email);

	expect((await askFor(phone, todayIST(), workers)).status()).toBe(400);
	// Before its first status row the pump was Inactive.
	expect((await askFor(phone, daysAgo(8), workers)).status()).toBe(409);
	// An Inactive stretch is not missed either.
	await db.query(
		`INSERT INTO pump_day_status (pump_id, day, status, set_by_role, set_by_id, set_by_name)
		 VALUES ($1, $2, 'inactive', 'admin', $3, 'Regression')`,
		[pump.id, daysAgo(4), randomUUID()]
	);
	const state = await (await phone.get('/api/pump/regularisation')).json();
	expect(state.days).toEqual([daysAgo(5), daysAgo(6)]);
	expect((await askFor(phone, daysAgo(3), workers)).status()).toBe(409);
	// A day with a photo is not missed.
	await db.query(
		`INSERT INTO attendance_sessions (pump_id, session_date, session_type, status, photo_hash)
		 VALUES ($1, $2, 'morning', 'completed', $3)`,
		[pump.id, daysAgo(5), randomUUID()]
	);
	expect((await askFor(phone, daysAgo(5), workers)).status()).toBe(409);

	expect((await askFor(phone, daysAgo(6), other.workers)).status()).toBe(400);
	expect((await askFor(phone, daysAgo(6), [])).status()).toBe(400);
	expect((await askFor(phone, daysAgo(6), workers, 'other')).status()).toBe(400);
	const ok = await askFor(phone, daysAgo(6), workers, 'other', 'Tyre burst on the way');
	expect(ok.status(), await ok.text()).toBe(200);
	expect((await askFor(phone, daysAgo(6), workers)).status()).toBe(409);
	expect((await phone.get(`/api/pump/regularisation?day=${daysAgo(9)}`)).status()).toBe(409);

	// Only the pump that asked may withdraw a waiting request.
	const otherPhone = await login(other.pump.email);
	const { id } = await (await askFor(otherPhone, daysAgo(1), other.workers)).json();
	expect((await phone.delete(`/api/pump/regularisation?id=${id}`)).status()).not.toBe(200);
	expect((await otherPhone.delete(`/api/pump/regularisation?id=${id}`)).status()).toBe(200);
	expect((await status(id)).status).toBe('cancelled');
});

test('REG-04 a plant with no business manager goes to the admins; an admin approves in the app and can undo', async () => {
	const { pump, workers } = await missedPump();
	const adminUser = await createAdmin();
	const admin = await login(adminUser.email);
	const phone = await login(pump.email);
	const day = daysAgo(1);
	const { id } = await (await askFor(phone, day, workers)).json();
	await requestMail(id, adminUser.email);

	const page = await (await admin.get('/admin/regularisations')).text();
	expect(page).toContain('data-testid="reg-decide"');
	expect(page).toContain(pump.code);

	const approved = await action(admin, '/admin/regularisations?/decide', {
		id,
		decision: 'approve'
	});
	expect(approved.type, JSON.stringify(approved)).toBe('success');
	expect((await status(id)).status).toBe('approved');
	expect(await counted(id)).toBe(3);

	const undone = await action(admin, '/admin/regularisations?/undo', {
		id,
		reason: 'Pump was in the workshop'
	});
	expect(undone.type, JSON.stringify(undone)).toBe('success');
	expect((await status(id)).status).toBe('undone');
	expect(await counted(id)).toBe(0);
	const { rows } = await db.query(
		`SELECT action FROM admin_audit_log WHERE target_id = $1 AND admin_id = $2 ORDER BY created_at`,
		[id, adminUser.id]
	);
	expect(rows.map((r) => r.action)).toEqual(['regularisation_approved', 'regularisation_undone']);
	expect((await (await phone.get('/api/pump/regularisation')).json()).days).toContain(day);

	// An admin's own request is approved at once.
	const own = await action(admin, '/admin/regularisations?/request', {
		pump_id: pump.id,
		day: daysAgo(2),
		reason: 'phone_problem',
		workers: workers[0]
	});
	expect(own.type, JSON.stringify(own)).toBe('success');
	const { rows: auto } = await db.query(
		'SELECT status FROM regularisations WHERE pump_id = $1 AND day = $2',
		[pump.id, daysAgo(2)]
	);
	expect(auto[0].status).toBe('approved');
});

test('REG-05 a plant manager asks for their own pump only; the business manager decides in the app, read only otherwise', async () => {
	const { pump, plantId, workers } = await missedPump();
	const bm = await businessManager(plantId);
	const manager = await login((await createPlantManager(plantId)).email);
	const stranger = await login((await createPlantManager((await createArea()).plantId)).email);

	const page = await (await manager.get('/plant-manager/regularisations')).text();
	expect(page).toContain('data-testid="reg-calendar"');
	// The checklist links a past day with no photo to the request form.
	const before = await (await manager.get(`/plant-manager?day=${daysAgo(1)}`)).text();
	expect(before).toContain('data-testid="checklist-regularise"');

	const form = {
		pump_id: pump.id,
		day: daysAgo(1),
		reason: 'phone_problem',
		workers: workers[0]
	};
	expect((await action(stranger, '/plant-manager/regularisations?/request', form)).type).toBe(
		'failure'
	);
	const asked = await action(manager, '/plant-manager/regularisations?/request', form);
	expect(asked.type, JSON.stringify(asked)).toBe('success');
	const { rows } = await db.query(
		'SELECT id, requested_by_role FROM regularisations WHERE pump_id = $1 AND day = $2',
		[pump.id, daysAgo(1)]
	);
	expect(rows[0].requested_by_role).toBe('plant_manager');
	await requestMail(rows[0].id, bm.email);
	const checklist = await (await manager.get(`/plant-manager?day=${daysAgo(1)}`)).text();
	expect(checklist).toContain('waiting for approval');

	// The one who asks does not decide.
	const self = await action(manager, '/plant-manager/regularisations?/decide', {
		id: rows[0].id,
		decision: 'approve'
	});
	expect(self.type).toBe('failure');

	// The business manager signs in read only: home is Missed days, other changes are refused.
	const bmContext = await login(bm.email);
	const home = await bmContext.get('/plant-manager', { maxRedirects: 0 });
	expect([302, 303, 307]).toContain(home.status());
	expect(home.headers().location).toContain('/plant-manager/regularisations');
	expect((await bmContext.get('/plant-manager/attendance', { maxRedirects: 0 })).status()).toBe(
		200
	);
	const blocked = await bmContext.post(`/api/persons/${workers[0]}/name`, {
		data: { name: 'Not Allowed' }
	});
	expect(blocked.status()).toBe(403);
	const decided = await action(bmContext, '/plant-manager/regularisations?/decide', {
		id: rows[0].id,
		decision: 'approve'
	});
	expect(decided.type, JSON.stringify(decided)).toBe('success');
	expect((await status(rows[0].id)).status).toBe('approved');
	const labelled = await (await manager.get(`/plant-manager?day=${daysAgo(1)}`)).text();
	expect(labelled).toContain('Regularised, 1 worker counted');
});

test('REG-06 approving is refused when a photo arrived after the request', async () => {
	const { pump, plantId, workers } = await missedPump();
	const bm = await businessManager(plantId);
	const phone = await login(pump.email);
	const day = daysAgo(2);
	const { id } = await (await askFor(phone, day, workers)).json();
	const mail = await requestMail(id, bm.email);
	await db.query(
		`INSERT INTO attendance_sessions (pump_id, session_date, session_type, status, photo_hash)
		 VALUES ($1, $2, 'morning', 'completed', $3)`,
		[pump.id, day, randomUUID()]
	);
	const result = await action(await anonymous(), `${pathOf(mail.approveUrl)}?/approve`, {});
	expect(result.type).toBe('failure');
	expect((await status(id)).status).toBe('pending');
});

// Log lines from every worker of the lane.
async function workerLines(texts: string[]) {
	return [...(await logLines('worker-1', texts, 0)), ...(await logLines('worker-2', texts, 0))];
}

test('REG-07 the worker reminds the business manager after 24 hours and the admins after 48', async () => {
	const { pump, plantId, workers } = await missedPump();
	const bm = await businessManager(plantId);
	const adminUser = await createAdmin();
	const phone = await login(pump.email);
	const { id } = await (await askFor(phone, daysAgo(1), workers)).json();
	const mails = (kind: string) =>
		workerLines([id, `"kind":"${kind}"`, 'regularisation email NOT sent (mail off)']);

	await db.query(
		`UPDATE regularisations SET requested_at = now() - interval '25 hours' WHERE id = $1`,
		[id]
	);
	await expect.poll(async () => (await mails('reminder')).length, { timeout: 15_000 }).toBe(1);
	expect((await mails('reminder'))[0].to).toBe(bm.email);
	expect((await mails('reminder'))[0].approveUrl).toContain('/regularisation/');

	await db.query(
		`UPDATE regularisations SET requested_at = now() - interval '49 hours' WHERE id = $1`,
		[id]
	);
	await expect
		.poll(async () => (await mails('escalation')).some((l) => l.to === adminUser.email), {
			timeout: 15_000
		})
		.toBe(true);
	expect((await mails('escalation')).some((l) => l.to === bm.email)).toBe(false);
	// Each is sent once.
	await new Promise((r) => setTimeout(r, 2500));
	expect(await mails('reminder')).toHaveLength(1);
});

test('REG-08 a pump phone with notifications on is reminded once a day of its missed days', async () => {
	const { pump } = await missedPump();
	const phone = await login(pump.email);
	// The phone fetches the push key before it subscribes; that makes the key pair.
	expect((await phone.get('/api/pump/push')).status()).toBe(200);
	const saved = await phone.post('/api/pump/push', {
		data: {
			endpoint: `${STUB_URL}/push/${randomUUID().replace(/-/g, '')}`,
			keys: {
				p256dh:
					'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
				auth: 'tBHItJI5svbpez7KI4CCXg'
			}
		}
	});
	expect(saved.status(), await saved.text()).toBeLessThan(300);
	const reminded = () => workerLines([pump.id, 'missed day reminder sent']);
	await expect.poll(async () => (await reminded()).length, { timeout: 15_000 }).toBe(1);
	expect((await reminded())[0].days).toBe(6);
	await new Promise((r) => setTimeout(r, 2500));
	expect(await reminded()).toHaveLength(1);
});

test('REG-09 phone screens at 390 px: the pump asks in three steps, the approver decides on the link page', async ({
	page
}, testInfo) => {
	test.setTimeout(60_000);
	const { pump, plantId } = await missedPump();
	const bm = await businessManager(plantId);
	const shot = (name: string) =>
		page.screenshot({ path: testInfo.outputPath(`reg-09-${name}.png`), fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, pump.email);

	await expect(page.getByTestId('reg-card')).toBeVisible();
	await shot('1-card');
	await noSidewaysScroll(page);
	await page.getByTestId('reg-start').click();
	await expect(page.getByTestId('reg-calendar')).toBeVisible();
	await page.getByTestId('reg-cal-apply').click();
	await expect(page.getByTestId('reg-sheet')).toBeVisible();
	await shot('2-why');
	await page.getByTestId('reg-reason-phone_problem').click();
	await page.getByTestId('reg-next').click();
	await expect(page.getByTestId('reg-face')).toHaveCount(3);
	await page.getByTestId('reg-face').nth(2).click();
	await shot('3-who');
	await page.getByTestId('reg-next').click();
	await shot('4-check');
	await page.getByTestId('reg-send').click();
	await expect(page.getByTestId('reg-sent')).toBeVisible();
	await page.getByTestId('reg-close').click();
	await expect(
		page.locator(`[data-testid="reg-cal-day"][data-day="${daysAgo(1)}"]`)
	).toHaveAttribute('data-state', 'waiting');
	await shot('5-waiting');

	const { rows } = await db.query(
		'SELECT id FROM regularisations WHERE pump_id = $1 AND day = $2',
		[pump.id, daysAgo(1)]
	);
	const ticked = await db.query(
		'SELECT 1 FROM regularisation_workers WHERE regularisation_id = $1',
		[rows[0].id]
	);
	expect(ticked.rowCount).toBe(2);
	const mail = await requestMail(rows[0].id, bm.email);
	await page.goto(`${pathOf(mail.approveUrl)}?do=approve`);
	await expect(page.getByTestId('reg-facts')).toBeVisible();
	await shot('6-link');
	await noSidewaysScroll(page);
	await page.getByTestId('reg-link-approve').click();
	await expect(page.getByTestId('reg-link-done')).toBeVisible();
	await shot('7-link-done');

	const month = await (
		await page.request.get(`/api/pump/regularisation?month=${daysAgo(1).slice(0, 7)}`)
	).json();
	expect(month.days.find((d: { day: string }) => d.day === daysAgo(1)).state).toBe('regularised');
});

test('REG-10 admin Missed days and Business managers pages at 390 px', async ({
	page
}, testInfo) => {
	const { pump, plantId, workers } = await missedPump();
	const adminUser = await createAdmin();
	await askFor(await login(pump.email), daysAgo(1), workers);
	const shot = (name: string) =>
		page.screenshot({ path: testInfo.outputPath(`reg-10-${name}.png`), fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, adminUser.email);

	await page.goto('/admin/regularisations');
	await expect(page.getByTestId('reg-decide').first()).toBeVisible();
	await shot('missed-days');
	await noSidewaysScroll(page);

	const admin = await login(adminUser.email);
	const email = `bmnew${randomUUID().slice(0, 6)}@regression.test`;
	const assigned = await action(admin, '/admin/business-managers?/assign', {
		plant_id: plantId,
		manager_id: '',
		name: 'New BM',
		email
	});
	expect(assigned.type, JSON.stringify(assigned)).toBe('success');
	const { rows } = await db.query(
		`SELECT pm.id FROM business_manager_plants b JOIN plant_managers pm ON pm.id = b.manager_id
		 WHERE b.plant_id = $1 AND pm.email = $2`,
		[plantId, email]
	);
	expect(rows).toHaveLength(1);
	await page.goto('/admin/business-managers');
	await expect(page.getByTestId('bm-list')).toContainText('New BM');
	await shot('business-managers');
	await noSidewaysScroll(page);

	const removed = await action(admin, '/admin/business-managers?/remove', { id: rows[0].id });
	expect(removed.type).toBe('success');
	const { rows: gone } = await db.query(
		'SELECT is_business_manager, disabled_at FROM plant_managers WHERE id = $1',
		[rows[0].id]
	);
	expect(gone[0].is_business_manager).toBe(false);
	expect(gone[0].disabled_at).not.toBeNull();
	expect(
		(await db.query('SELECT 1 FROM business_manager_plants WHERE plant_id = $1', [plantId]))
			.rowCount
	).toBe(0);
});
