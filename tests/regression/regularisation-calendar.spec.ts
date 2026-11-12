// REG-11 to REG-18: the regularisation calendar. Pick a date and apply: a day with no photo (dark
// red) or a day where a worker has only a start or only an end (light red). Only workers still on
// the pump with a real photo attendance there can be selected. Real app, database and worker;
// emails are log lines.
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
	loadRegularisationFacts,
	renderRegularisationEmail
} from '../../worker/regularisationEmail.js';
import {
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
import {
	addDay,
	askFor,
	calendarDay,
	crewPump,
	daysAgo,
	monthOf,
	noSidewaysScroll,
	showMonth,
	signIn,
	todayIST
} from './regularisationHelpers';

const shots = path.resolve('artifacts', 'deep-build', 'screenshots');
fs.mkdirSync(shots, { recursive: true });

type Crew = { personId: string; label: string; ticked: boolean; half: string | null };

async function crewOf(phone: Awaited<ReturnType<typeof login>>, day: string) {
	const response = await phone.get(`/api/pump/regularisation?day=${day}`);
	expect(response.status(), await response.text()).toBe(200);
	return (await response.json()) as { crew: Crew[]; kind: string };
}

async function adminLogin() {
	const user = await createAdmin();
	return { user, admin: await login(user.email) };
}

async function row(person: string, day: string) {
	const { rows } = await db.query(
		`SELECT morning_matched, evening_matched, regularisation_id
		 FROM daily_person_attendance WHERE person_id = $1 AND session_date = $2`,
		[person, day]
	);
	return rows[0] as {
		morning_matched: boolean;
		evening_matched: boolean;
		regularisation_id: string | null;
	};
}

// Console errors and failed requests a critical flow should not have. A worker with no stored face
// answers 404 by design in these fixtures.
function watch(page: import('@playwright/test').Page) {
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
	page.on('console', (m) => {
		if (m.type() === 'error' && !m.location().url.includes('/face')) {
			problems.push(`console: ${m.text()}`);
		}
	});
	page.on('response', (r) => {
		if (r.status() >= 500) problems.push(`${r.status()} ${r.url()}`);
	});
	return problems;
}

test('REG-11 only current workers with a real photo attendance can be selected', async () => {
	const { pump, workers } = await crewPump();
	const phone = await login(pump.email);
	const day = daysAgo(1);

	// Crew 5 is only counted through an earlier regularised day, so it has no real attendance.
	const { rows: extra } = await db.query(
		`INSERT INTO persons (pump_id, display_seq, name) VALUES ($1, 5, 'Crew 5') RETURNING id`,
		[pump.id]
	);
	const onlyRegularised = extra[0].id as string;
	const { rows: earlier } = await db.query(
		`INSERT INTO regularisations (pump_id, day, reason, requested_by_role, requested_by_id, requested_by_name, status, link_base)
		 VALUES ($1, $2, 'forgot', 'pump', $3, 'Regression', 'approved', 'http://x') RETURNING id`,
		[pump.id, daysAgo(15), randomUUID()]
	);
	await db.query(
		`INSERT INTO regularisation_workers (regularisation_id, person_id) VALUES ($1, $2)`,
		[earlier[0].id, onlyRegularised]
	);
	await db.query(
		`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched, evening_matched, regularisation_id)
		 VALUES ($1, $2, $3, true, true, $4)`,
		[onlyRegularised, pump.id, daysAgo(15), earlier[0].id]
	);
	// Crew 3 left the pump: archived, with real history.
	await db.query(`UPDATE persons SET status = 'archived' WHERE id = $1`, [workers[2]]);

	const { crew, kind } = await crewOf(phone, day);
	expect(kind).toBe('missed');
	expect(crew.map((c) => c.label)).toEqual(['Crew 1', 'Crew 2']);

	for (const forged of [workers[2], workers[3], onlyRegularised]) {
		const response = await askFor(phone, day, [forged]);
		expect(response.status(), await response.text()).toBe(400);
	}
	const fine = await askFor(phone, day, [workers[0]]);
	expect(fine.status(), await fine.text()).toBe(200);
});

test('REG-12 the calendar shows each day and only Apply days can be asked for', async () => {
	const { pump, workers } = await crewPump();
	const phone = await login(pump.email);
	const { admin } = await adminLogin();
	const three = workers.slice(0, 3);

	await addDay(
		pump.id,
		daysAgo(2),
		three.map((id) => ({ id, start: true, end: true })),
		'paired'
	);
	await addDay(pump.id, daysAgo(3), [
		{ id: workers[0], start: true, end: false },
		{ id: workers[1], start: true, end: true }
	]);
	await addDay(pump.id, daysAgo(7), [{ id: workers[0], start: true, end: false }], 'open');
	const waiting = await (await askFor(phone, daysAgo(4), three)).json();
	expect(waiting.status).toBe('pending');
	const approved = await (await askFor(phone, daysAgo(5), three)).json();
	expect(
		(await action(admin, '/admin/regularisations?/decide', { id: approved.id, decision: 'approve' }))
			.type
	).toBe('success');
	const rejected = await (await askFor(phone, daysAgo(6), three)).json();
	expect(
		(
			await action(admin, '/admin/regularisations?/decide', {
				id: rejected.id,
				decision: 'reject',
				reject_reason: 'wrong_crew'
			})
		).type
	).toBe('success');

	const expected: [number, string, boolean][] = [
		[1, 'missed', true],
		[2, 'full', false],
		[3, 'partial', true],
		[4, 'waiting', false],
		[5, 'regularised', false],
		[6, 'rejected', true],
		[7, 'none', false],
		[8, 'missed', true],
		[9, 'none', false]
	];
	for (const [ago, state, canApply] of expected) {
		const day = daysAgo(ago);
		const cell = await calendarDay(phone, day);
		expect(cell.state, day).toBe(state);
		expect(cell.canApply, day).toBe(canApply);
		// The calendar and the apply check never disagree.
		expect((await phone.get(`/api/pump/regularisation?day=${day}`)).status(), day).toBe(
			canApply ? 200 : 409
		);
	}
	expect((await calendarDay(phone, daysAgo(7))).note).toBe('open');
	expect((await calendarDay(phone, daysAgo(9))).note).toBe('inactive');
	const today = await calendarDay(phone, todayIST());
	expect(today.state).toBe('none');
	expect(today.note).toBe('today');
	expect((await askFor(phone, todayIST(), three)).status()).toBe(400);
	expect((await askFor(phone, daysAgo(7), [workers[0]])).status()).toBe(409);
	expect((await phone.get('/api/pump/regularisation?month=2099-01')).status()).toBe(400);
	expect((await phone.get('/api/pump/regularisation?month=nonsense')).status()).toBe(400);
});

test('REG-13 a half-counted day adds only the missing half and undo keeps the real photo', async () => {
	const { pump, workers } = await crewPump();
	const phone = await login(pump.email);
	const { admin } = await adminLogin();
	const day = daysAgo(3);
	await addDay(pump.id, day, [
		{ id: workers[0], start: true, end: false },
		{ id: workers[1], start: false, end: true },
		{ id: workers[2], start: true, end: true }
	]);

	const { crew, kind } = await crewOf(phone, day);
	expect(kind).toBe('partial');
	expect(crew.map((c) => [c.label, c.half, c.ticked])).toEqual([
		['Crew 1', 'start', true],
		['Crew 2', 'end', true]
	]);
	expect((await askFor(phone, day, [workers[2]])).status()).toBe(400);

	const { id } = await (await askFor(phone, day, [workers[0], workers[1]])).json();
	expect((await calendarDay(phone, day)).state).toBe('waiting');
	const decided = await action(admin, '/admin/regularisations?/decide', {
		id,
		decision: 'approve'
	});
	expect(decided.type, JSON.stringify(decided)).toBe('success');

	expect(await row(workers[0], day)).toEqual({
		morning_matched: true,
		evening_matched: true,
		regularisation_id: id
	});
	expect(await row(workers[1], day)).toEqual({
		morning_matched: true,
		evening_matched: true,
		regularisation_id: id
	});
	expect((await row(workers[2], day)).regularisation_id).toBeNull();
	expect((await calendarDay(phone, day)).state).toBe('regularised');

	const undone = await action(admin, '/admin/regularisations?/undo', {
		id,
		reason: 'Asked for by mistake'
	});
	expect(undone.type, JSON.stringify(undone)).toBe('success');
	expect(await row(workers[0], day)).toEqual({
		morning_matched: true,
		evening_matched: false,
		regularisation_id: null
	});
	expect(await row(workers[1], day)).toEqual({
		morning_matched: false,
		evening_matched: true,
		regularisation_id: null
	});
	expect(await row(workers[2], day)).toMatchObject({
		morning_matched: true,
		evening_matched: true
	});
	const after = await calendarDay(phone, day);
	expect(after.state).toBe('partial');
	expect(after.canApply).toBe(true);
});

test('REG-14 a half that arrives before approval is skipped, and nothing left is refused', async () => {
	const { pump, workers } = await crewPump();
	const phone = await login(pump.email);
	const { admin } = await adminLogin();
	const halves = [
		{ id: workers[0], start: true, end: false },
		{ id: workers[1], start: true, end: false }
	];
	const day = daysAgo(3);
	await addDay(pump.id, day, halves);
	const { id } = await (await askFor(phone, day, [workers[0], workers[1]])).json();
	await db.query(
		`UPDATE daily_person_attendance SET evening_matched = true WHERE person_id = $1 AND session_date = $2`,
		[workers[0], day]
	);
	const ok = await action(admin, '/admin/regularisations?/decide', { id, decision: 'approve' });
	expect(ok.type, JSON.stringify(ok)).toBe('success');
	expect((await row(workers[0], day)).regularisation_id).toBeNull();
	expect((await row(workers[1], day)).regularisation_id).toBe(id);

	const other = daysAgo(4);
	await addDay(pump.id, other, halves);
	const second = await (await askFor(phone, other, [workers[0]])).json();
	await db.query(
		`UPDATE daily_person_attendance SET evening_matched = true WHERE person_id = $1 AND session_date = $2`,
		[workers[0], other]
	);
	const refused = await action(admin, '/admin/regularisations?/decide', {
		id: second.id,
		decision: 'approve'
	});
	expect(refused.type).toBe('failure');
	const { rows } = await db.query('SELECT status FROM regularisations WHERE id = $1', [second.id]);
	expect(rows[0].status).toBe('pending');
});

test('REG-15 the approver sees which half each worker is missing', async () => {
	const { pump, workers } = await crewPump();
	const phone = await login(pump.email);
	const { user } = await adminLogin();
	const day = daysAgo(3);
	await addDay(pump.id, day, [
		{ id: workers[0], start: true, end: false },
		{ id: workers[1], start: false, end: true }
	]);
	const { id } = await (await askFor(phone, day, [workers[0], workers[1]])).json();

	const facts = await loadRegularisationFacts(db, id);
	const email = renderRegularisationEmail(facts, 'request', 'http://x/regularisation/t');
	expect(email.text).toContain('Crew 1 (end requested)');
	expect(email.text).toContain('Crew 2 (start requested)');
	expect(email.text).toContain('one photo arrived');

	let link = '';
	await expect
		.poll(async () => {
			const lines = await logLines('app', [id, 'regularisation email NOT sent (mail off)'], 0);
			link = (lines.find((l) => l.to === user.email) as { approveUrl?: string })?.approveUrl ?? '';
			return Boolean(link);
		})
		.toBe(true);
	const browser = await anonymous();
	const page = await (await browser.get(new URL(link).pathname + '?do=approve')).text();
	expect(page).toContain('Crew 1 (end requested)');
});

test('REG-16 the operator picks a light red day and applies in three steps at 390 px', async ({
	page
}) => {
	const { pump, workers } = await crewPump();
	const problems = watch(page);
	const day = daysAgo(3);
	await addDay(pump.id, day, [
		{ id: workers[0], start: true, end: false },
		{ id: workers[1], start: true, end: false },
		{ id: workers[2], start: true, end: true }
	]);
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, pump.email);

	await page.getByTestId('reg-start').click();
	await expect(page.getByTestId('reg-calendar')).toBeVisible();
	const cell = await showMonth(page, day);
	await expect(cell).toHaveAttribute('data-state', 'partial');
	await noSidewaysScroll(page);
	await page.screenshot({ path: path.join(shots, 'mobile.png') });
	await cell.click();
	await expect(page.getByTestId('reg-cal-panel')).toBeVisible();
	await page.getByTestId('reg-cal-apply').click();

	await page.getByTestId('reg-reason-phone_problem').click();
	await page.getByTestId('reg-next').click();
	await expect(page.getByTestId('reg-face')).toHaveCount(2);
	await expect(page.getByTestId('reg-face-half')).toHaveCount(2);
	await page.getByTestId('reg-next').click();
	await page.getByTestId('reg-send').click();
	await expect(page.getByTestId('reg-sent')).toBeVisible();
	await page.getByTestId('reg-close').click();
	await expect(
		page.locator(`[data-testid="reg-cal-day"][data-day="${day}"]`)
	).toHaveAttribute('data-state', 'waiting');

	// Still there after a reload, and stored as asked.
	await page.reload();
	await page.getByTestId('reg-start').click();
	const again = await showMonth(page, day);
	await expect(again).toHaveAttribute('data-state', 'waiting');
	const { rows } = await db.query(
		`SELECT rw.adds FROM regularisation_workers rw
		 JOIN regularisations r ON r.id = rw.regularisation_id
		 WHERE r.pump_id = $1 AND r.day = $2 AND r.status = 'pending'`,
		[pump.id, day]
	);
	expect(rows.map((r) => r.adds)).toEqual(['end', 'end']);
	expect(problems).toEqual([]);
});

test('REG-17 an admin picks a pump and a date on the same calendar and the day counts', async ({
	page
}) => {
	const { pump, workers } = await crewPump();
	const { user } = await adminLogin();
	const problems = watch(page);
	const day = daysAgo(1);
	await page.setViewportSize({ width: 1280, height: 800 });
	await signIn(page, user.email);
	await page.goto(`/admin/regularisations?pump=${pump.id}&month=${monthOf(day)}`);
	await expect(page.getByTestId('reg-calendar')).toBeVisible();
	await expect(page.getByTestId('reg-pump')).toHaveValue(pump.id);

	const cell = page.locator(`[data-testid="reg-cal-day"][data-day="${day}"]`);
	await expect(cell).toHaveAttribute('data-state', 'missed');
	await cell.click();
	const form = page.getByTestId('reg-form');
	await expect(form).toBeVisible();
	await expect(form.locator('input[name="workers"]')).toHaveCount(3);
	await form.locator('input[value="phone_problem"]').check();
	await page.getByTestId('reg-send').click();
	await expect(page.getByTestId('reg-request-message')).toContainText('Regularised');
	await expect(cell).toHaveAttribute('data-state', 'regularised');
	await page.getByTestId('reg-pump').scrollIntoViewIfNeeded();
	await page.evaluate(() =>
		document.querySelector('[data-testid="reg-pump"]')?.scrollIntoView({ block: 'start' })
	);
	await page.screenshot({ path: path.join(shots, 'desktop.png') });

	await page.reload();
	await expect(cell).toHaveAttribute('data-state', 'regularised');
	const { rows } = await db.query(
		`SELECT count(*)::int AS n FROM daily_person_attendance
		 WHERE pump_id = $1 AND session_date = $2 AND regularisation_id IS NOT NULL`,
		[pump.id, day]
	);
	expect(rows[0].n).toBe(3);
	expect(workers).toHaveLength(4);
	expect(problems).toEqual([]);
});

test('REG-18 a plant manager applies on the same calendar for their own pumps only, at 390 px', async ({
	page
}) => {
	const { pump, plantId, workers } = await crewPump();
	const manager = await createPlantManager(plantId);
	const day = daysAgo(3);
	await addDay(pump.id, day, [{ id: workers[0], start: true, end: false }]);
	const foreign = await createPump((await createArea()).plantId);
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, manager.email);

	await page.goto(`/plant-manager/regularisations?pump=${foreign.id}`);
	await expect(page.getByTestId('reg-pump')).toHaveValue(pump.id);

	await page.goto(
		`/plant-manager/regularisations?pump=${pump.id}&month=${monthOf(day)}&day=${day}`
	);
	const form = page.getByTestId('reg-form');
	await expect(form).toBeVisible();
	await expect(form.locator('input[name="workers"]')).toHaveCount(1);
	await expect(form).toContainText('Start done, end missing');
	await noSidewaysScroll(page);
	await page.screenshot({
		path: path.join(shots, 'plant-manager-mobile.png'),
		fullPage: true
	});
	await form.locator('input[value="forgot"]').check();
	await page.getByTestId('reg-send').click();
	await expect(page.getByTestId('reg-request-message')).toContainText('Sent for approval');
	await expect(
		page.locator(`[data-testid="reg-cal-day"][data-day="${day}"]`)
	).toHaveAttribute('data-state', 'waiting');
});
