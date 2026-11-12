// ADM-14: the pump list of an Area and a Plant shows only the pumps Active or Idle today, each with
// that status. A pump with no status counts as Inactive, and a status set for tomorrow does not
// count yet.
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createAdmin, createArea, createPump, db } from './helpers';
import { daysAgo, noSidewaysScroll, signIn } from './regularisationHelpers';

const setStatus = (pumpId: string, day: string, status: string, adminId: string) =>
	db.query(
		`INSERT INTO pump_day_status (pump_id, day, status, set_by_role, set_by_id, set_by_name)
		 VALUES ($1, $2, $3, 'admin', $4, 'Regression')`,
		[pumpId, day, status, adminId]
	);

test('ADM-14 Area and Plant list only Active and Idle pumps, with their status', async ({
	page
}) => {
	const admin = await createAdmin();
	const { areaId, plantId } = await createArea();
	const [active, idle, wentInactive, noStatus, fromTomorrow] = await Promise.all(
		Array.from({ length: 5 }, () => createPump(plantId))
	);
	// Set days ago and held since: a status lasts until the next change.
	await setStatus(active.id, daysAgo(5), 'active', admin.id);
	await setStatus(idle.id, daysAgo(0), 'idle', admin.id);
	await setStatus(wentInactive.id, daysAgo(5), 'active', admin.id);
	await setStatus(wentInactive.id, daysAgo(1), 'inactive', admin.id);
	await setStatus(fromTomorrow.id, daysAgo(-1), 'active', admin.id);
	// The Active pump has one worker counted today; the Idle one has nobody (light red row).
	const { rows: person } = await db.query(
		`INSERT INTO persons (pump_id, display_seq, name) VALUES ($1, 1, 'Crew 1') RETURNING id`,
		[active.id]
	);
	await db.query(
		`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched, evening_matched)
		 VALUES ($1, $2, $3, true, true)`,
		[person[0].id, active.id, daysAgo(0)]
	);

	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, admin.email);

	for (const path of [`/admin/areas/${areaId}`, `/admin/plants/${plantId}`]) {
		await page.goto(path);
		const rows = page.getByTestId('pump-today-row');
		await expect(rows).toHaveCount(2);
		await expect(rows.filter({ hasText: active.code })).toHaveAttribute('data-status', 'active');
		await expect(rows.filter({ hasText: active.code })).toContainText('Active');
		await expect(rows.filter({ hasText: idle.code })).toHaveAttribute('data-status', 'idle');
		await expect(rows.filter({ hasText: idle.code })).toContainText('Idle');
		await expect(rows.filter({ hasText: active.code })).toHaveAttribute('data-attendance', 'some');
		await expect(rows.filter({ hasText: idle.code })).toHaveAttribute('data-attendance', 'none');
		const tint = (code: string) =>
			rows.filter({ hasText: code }).evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(await tint(idle.code)).toBe('rgb(253, 236, 234)');
		expect(await tint(active.code)).not.toBe('rgb(253, 236, 234)');
		for (const hidden of [wentInactive, noStatus, fromTomorrow]) {
			await expect(rows.filter({ hasText: hidden.code })).toHaveCount(0);
		}
		await noSidewaysScroll(page);
	}

	await page.goto(`/admin/areas/${areaId}`);
	await page.getByTestId('pump-today-list').screenshot({ path: 'artifacts/pump-list/mobile.png' });
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.getByTestId('pump-today-list').screenshot({ path: 'artifacts/pump-list/desktop.png' });
});

test('ADM-15 A flag marked "not fraud" leaves the fraud counts', async ({ page }) => {
	const admin = await createAdmin();
	const { areaId, plantId } = await createArea();
	const [flagged, other] = await Promise.all([createPump(plantId), createPump(plantId)]);
	for (const pump of [flagged, other]) await setStatus(pump.id, daysAgo(0), 'active', admin.id);
	const session = async (pumpId: string) =>
		(
			await db.query(
				`INSERT INTO attendance_sessions (pump_id, session_date, session_type, status, photo_hash)
				 VALUES ($1, $2, 'morning', 'completed', $3) RETURNING id`,
				[pumpId, daysAgo(0), randomUUID()]
			)
		).rows[0].id as string;
	const [flaggedSession, otherSession] = [await session(flagged.id), await session(other.id)];
	const { rows: person } = await db.query(
		`INSERT INTO persons (pump_id, display_seq, name) VALUES ($1, 1, 'Crew 1') RETURNING id`,
		[other.id]
	);
	const flag = (resolution: string | null) =>
		db.query(
			`INSERT INTO fraud_flags (session_id, person_id, matched_at_pump_id, matched_session_id,
			                          similarity_score, reviewed, resolution)
			 VALUES ($1, $2, $3, $4, 0.9, $5, $6)`,
			[flaggedSession, person[0].id, other.id, otherSession, resolution !== null, resolution]
		);
	// Two flags cleared by an admin: nothing shows as fraud.
	await flag('not_fraud');
	await flag('not_fraud');
	await signIn(page, admin.email);
	const fraudTags = page.getByText(/^\d+ fraud$/);
	for (const path of [`/admin/areas/${areaId}`, `/admin/plants/${plantId}`]) {
		await page.goto(path);
		await expect(page.getByTestId('pump-today-row')).toHaveCount(2);
		await expect(fraudTags).toHaveCount(0);
	}
	// One still open: it shows, and only it is counted.
	await flag(null);
	await page.goto(`/admin/areas/${areaId}`);
	await expect(page.getByText('1 fraud').first()).toBeVisible();
	await expect(page.getByText(/^[2-9] fraud$/)).toHaveCount(0);
});

test('ADM-14 An Area with no Active or Idle pump says so', async ({ page }) => {
	const admin = await createAdmin();
	const { areaId, plantId } = await createArea();
	await createPump(plantId);
	await signIn(page, admin.email);
	await page.goto(`/admin/areas/${areaId}`);
	await expect(page.getByTestId('pump-today-row')).toHaveCount(0);
	await expect(page.getByTestId('pump-today-list')).toContainText(
		'No Active or Idle pumps here today.'
	);
});
