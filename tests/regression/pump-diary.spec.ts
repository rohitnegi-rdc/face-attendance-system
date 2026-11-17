// ADM-18: the admin pump page answers "did this pump send attendance on day X" without server
// commands. Day by day (newest first), each photo sits on the day it was SENT with the shift it
// counted for (a night shift's end photo sent this morning counts for yesterday), a start closed
// without an end says how, a photo the server refused shows the operator's reason, and an Active
// day with nothing sent is light red. (2026-11-17: PUMPMU6's 6:58 am photo "was missing" on the
// 16th; it was the end of the 15th's night shift.)
import { expect, test } from '@playwright/test';
import { createAdmin, db, login, photo, submit } from './helpers';
import { crewPump, daysAgo, noSidewaysScroll, signIn, todayIST } from './regularisationHelpers';

const at = async (day: string, time: string) =>
	(
		await db.query(`SELECT (($1::date + $2::time)::timestamp AT TIME ZONE 'Asia/Kolkata') AS t`, [
			day,
			time
		])
	).rows[0].t as Date;

async function session(
	pumpId: string,
	sessionDate: string,
	type: 'morning' | 'evening',
	sentAt: Date,
	pairing: string,
	extra: { closedBy?: string; closedAt?: Date; pairedWith?: string } = {}
) {
	const { rows } = await db.query(
		`INSERT INTO attendance_sessions (pump_id, session_date, session_type, status, photo_hash,
		                                  pairing_status, submitted_at, closed_by, closed_at, paired_session_id)
		 VALUES ($1, $2, $3, 'completed', gen_random_uuid()::text, $4, $5, $6, $7, $8) RETURNING id`,
		[
			pumpId,
			sessionDate,
			type,
			pairing,
			sentAt,
			extra.closedBy ?? null,
			extra.closedAt ?? null,
			extra.pairedWith ?? null
		]
	);
	return rows[0].id as string;
}

const counted = (person: string, pumpId: string, day: string, end: boolean) =>
	db.query(
		`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched, evening_matched)
		 VALUES ($1, $2, $3, true, $4)`,
		[person, pumpId, day, end]
	);

test('ADM-18 the pump page lists each day what the pump sent, refused photos included', async ({
	page
}) => {
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(String(e)));
	page.on('console', (m) => {
		if (m.type() === 'error' && !m.text().startsWith('Failed to load resource'))
			problems.push(m.text());
	});
	// Seeded sessions have no photo files, so their thumbnails 404; anything else failing counts.
	page.on('response', (r) => {
		if (
			r.status() >= 400 &&
			!/\/api\/(attendance\/photo|persons\/[^/]+\/face|attendance\/face)/.test(r.url())
		)
			problems.push(`${r.status()} ${r.url()}`);
	});

	const admin = await createAdmin();
	const { pump, workers } = await crewPump(); // Active since 8 days ago
	const night = daysAgo(3);
	const morningAfter = daysAgo(2);
	const empty = daysAgo(4);

	// Night shift: start 9:17 pm, end next day 6:58 am, both counted for `night`.
	const start = await session(pump.id, night, 'morning', await at(night, '21:17'), 'paired');
	await session(pump.id, night, 'evening', await at(morningAfter, '06:58'), 'paired', {
		pairedWith: start
	});
	for (const id of workers.slice(0, 2)) await counted(id, pump.id, night, true);
	// The next day: a start at 8 am, ended from the pump at 6 pm without an end photo.
	await session(pump.id, morningAfter, 'morning', await at(morningAfter, '08:00'), 'expired', {
		closedBy: 'pump',
		closedAt: await at(morningAfter, '18:00')
	});
	await counted(workers[0], pump.id, morningAfter, false);

	// Today through the real submit endpoint: a start, then the same photo again (refused).
	const pumpApi = await login(pump.email);
	const group = await photo(['DIARY-A']);
	expect((await submit(pumpApi, group)).status).toBe(202);
	const again = await submit(pumpApi, group);
	expect(again.status).toBeGreaterThanOrEqual(400);
	expect(again.body.error).toContain('Duplicate photo');
	await expect
		.poll(
			async () =>
				(
					await db.query(
						`SELECT count(*)::int AS n FROM system_logs
						 WHERE pump_id = $1 AND message = 'attendance submission rejected'`,
						[pump.id]
					)
				).rows[0].n
		)
		.toBe(1);

	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, admin.email);
	await page.goto(`/admin/pumps/${pump.id}?from=${daysAgo(6)}&to=${todayIST()}`);
	const days = page.getByTestId('diary-day');
	await expect(days).toHaveCount(7); // every day of the range, nothing hidden
	await expect(days.first()).toHaveAttribute('data-day', todayIST()); // newest first

	const today = page.locator(`[data-testid="diary-day"][data-day="${todayIST()}"]`);
	// (crewPump's old seeded day is stamped as sent now, so pick today's real submit.)
	await expect(
		today.locator('[data-kind="photo"]').filter({ hasNotText: 'counts for' })
	).toContainText('Shift start photo sent');
	await expect(today.locator('[data-kind="refused"]')).toContainText(
		'Photo refused: Duplicate photo - already submitted'
	);

	const after = page.locator(`[data-testid="diary-day"][data-day="${morningAfter}"]`);
	const events = after.getByTestId('diary-event');
	await expect(events).toHaveCount(3);
	await expect(events.nth(0)).toContainText('6:58');
	await expect(events.nth(0)).toContainText('Shift end photo sent · counts for');
	await expect(events.nth(0)).toContainText('(night shift)');
	await expect(events.nth(1)).toContainText('8:00');
	await expect(events.nth(2)).toContainText('the pump pressed End session');
	await expect(after.getByTestId('split-start')).toContainText('1 start only');

	const nightDay = page.locator(`[data-testid="diary-day"][data-day="${night}"]`);
	await expect(nightDay.getByTestId('diary-event')).toContainText('9:17');
	await expect(nightDay.getByTestId('split-full')).toContainText('2 full shift');

	const emptyDay = page.locator(`[data-testid="diary-day"][data-day="${empty}"]`);
	await expect(emptyDay).toContainText('Nothing sent this day');
	await expect(emptyDay).toContainText('Nobody counted for this day');
	await expect(emptyDay).toHaveCSS('background-color', 'rgb(253, 236, 234)');

	await expect(page.getByTestId('diary-total').getByTestId('split-full')).toContainText('2');
	await noSidewaysScroll(page);
	await page.getByTestId('pump-diary').scrollIntoViewIfNeeded();
	await page.screenshot({ path: 'artifacts/deep-build/screenshots/pump-diary-mobile.png' });
	await after.scrollIntoViewIfNeeded();
	await page.screenshot({ path: 'artifacts/deep-build/screenshots/pump-diary-mobile-night.png' });
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.getByTestId('pump-diary').scrollIntoViewIfNeeded();
	await page.screenshot({ path: 'artifacts/deep-build/screenshots/pump-diary-desktop.png' });

	expect(problems).toEqual([]);
});

test('ADM-18 a pump login cannot open the pump day by day page', async () => {
	const { pump } = await crewPump();
	const pumpApi = await login(pump.email);
	const response = await pumpApi.get(`/admin/pumps/${pump.id}`, { maxRedirects: 0 });
	expect(response.status()).not.toBe(200);
	expect(await response.text()).not.toContain('pump-diary');
});
