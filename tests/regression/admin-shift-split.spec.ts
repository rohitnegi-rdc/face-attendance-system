// ADM-17: admins see today's workers split into full shift, start only and end only, like the plant
// manager's checklist and the 9 am email: on the Overview, the Area and plant cards, the Area pump
// list and the Attendance page (metrics, day summary per pump, each worker, the Status filter).
import { expect, test, type Locator } from '@playwright/test';
import { createAdmin, createArea, createPump, db } from './helpers';
import { daysAgo, noSidewaysScroll, signIn } from './regularisationHelpers';

test('ADM-17 admin pages split workers into full shift, start only and end only', async ({
	page
}) => {
	const admin = await createAdmin();
	const { areaId, plantId } = await createArea();
	const pump = await createPump(plantId);
	await db.query(
		`INSERT INTO pump_day_status (pump_id, day, status, set_by_role, set_by_id, set_by_name)
		 VALUES ($1, $2, 'active', 'admin', $3, 'Regression')`,
		[pump.id, daysAgo(0), admin.id]
	);
	// 2 full shift, 1 start only, 1 end only.
	const halves: [boolean, boolean][] = [
		[true, true],
		[true, true],
		[true, false],
		[false, true]
	];
	for (const [i, [morning, evening]] of halves.entries()) {
		const { rows } = await db.query(
			`INSERT INTO persons (pump_id, display_seq, name) VALUES ($1, $2, $3) RETURNING id`,
			[pump.id, i + 1, `Crew ${i + 1}`]
		);
		await db.query(
			`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched, evening_matched)
			 VALUES ($1, $2, $3, $4, $5)`,
			[rows[0].id, pump.id, daysAgo(0), morning, evening]
		);
	}
	const expectSplit = async (split: Locator) => {
		await expect(split.getByTestId('split-full')).toHaveText('2 full shift');
		await expect(split.getByTestId('split-start')).toHaveText('1 start only');
		await expect(split.getByTestId('split-end')).toHaveText('1 end only');
	};

	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, admin.email);

	// Area page: the plant card and the pump row.
	await page.goto(`/admin/areas/${areaId}`);
	await expectSplit(page.getByTestId('area-plants').getByTestId('shift-split'));
	await expectSplit(page.getByTestId('pump-today-row').getByTestId('shift-split'));
	await noSidewaysScroll(page);
	await page.screenshot({ path: 'artifacts/shift-split/area-mobile.png', fullPage: true });

	// Overview has the whole platform's today; just check the split is there.
	await page.goto('/admin');
	await expect(page.getByTestId('today-split').getByTestId('split-start')).toBeVisible();

	// Attendance page, one day.
	await page.goto(`/admin/attendance?day=${daysAgo(0)}&pump=${pump.id}`);
	const summaryRow = page.locator('.pump-summary tbody tr').first();
	await expect(summaryRow.locator('td').nth(2)).toHaveText('2');
	await expect(summaryRow.locator('td').nth(3)).toHaveText('1');
	await expect(summaryRow.locator('td').nth(4)).toHaveText('1');
	await page.screenshot({ path: 'artifacts/shift-split/attendance-day-mobile.png', fullPage: true });

	// Range view, filtered to start only: one worker, labelled Start only.
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto(
		`/admin/attendance?from=${daysAgo(0)}&to=${daysAgo(0)}&pump=${pump.id}&status=start_only`
	);
	const rows = page.getByTestId('attendance-table').locator('tbody tr');
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText('Start only');
	await page.goto(`/admin/attendance?from=${daysAgo(0)}&to=${daysAgo(0)}&pump=${pump.id}`);
	await expect(rows).toHaveCount(4);
	await expect(rows.filter({ hasText: 'End only' })).toHaveCount(1);
	await expect(rows.filter({ hasText: 'Full shift' })).toHaveCount(2);
	await page.screenshot({
		path: 'artifacts/shift-split/attendance-range-desktop.png',
		fullPage: true
	});
	await page.goto(`/admin/areas/${areaId}`);
	await page.screenshot({ path: 'artifacts/shift-split/area-desktop.png', fullPage: true });
});
