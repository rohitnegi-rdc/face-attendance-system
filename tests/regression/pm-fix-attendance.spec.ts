// FIX-01: the plant manager has the admin's Fix attendance (one shared page, fixAttendance.ts):
// rename a worker, mark a worker counted twice and undo it, add a worker the camera missed. The
// face popup on the shift card and the People page rename too. Another plant's manager is refused
// everywhere, and every change is logged with the manager.
import { test, expect, type Page } from '@playwright/test';
import {
	action,
	createArea,
	createPlantManager,
	createPump,
	count,
	db,
	login,
	PASSWORD,
	recordSession
} from './helpers';

async function signIn(page: Page, email: string) {
	await page.goto('/login');
	await page.getByTestId('login-email').fill(email);
	await page.getByTestId('login-password').fill(PASSWORD);
	await page.getByTestId('login-submit').click();
	await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function shots(page: Page, name: string, testInfo: { outputPath: (p: string) => string }) {
	for (const width of [390, 1440]) {
		await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
		await page.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`), fullPage: true });
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow, `horizontal scroll at ${width}px`).toBeLessThanOrEqual(0);
	}
	await page.setViewportSize({ width: 390, height: 844 });
}

test('FIX-01 the plant manager fixes attendance like the admin', async ({ page }, testInfo) => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const start = await recordSession(await login(pump.email), ['FIX01A', 'FIX01B']);
	const { rows } = await db.query(
		`SELECT p.id, s.session_date::text AS day FROM attendance_face_evidence afe
		 JOIN persons p ON p.id = afe.person_id JOIN attendance_sessions s ON s.id = afe.session_id
		 WHERE afe.session_id = $1 ORDER BY p.display_seq`,
		[start]
	);
	const [a, b] = rows.map((row) => row.id as string);
	const day = rows[0].day as string;
	const manager = await createPlantManager(plantId);
	const fixUrl = `/plant-manager/attendance/correct?pump=${pump.id}&day=${day}`;

	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, manager.email);
	await page.goto(fixUrl);
	await expect(page.getByRole('heading', { name: 'Fix attendance' })).toBeVisible();
	await expect(page.getByTestId('fix-worker')).toHaveCount(2);
	await shots(page, '1-fix-attendance', testInfo);

	// Rename under the row.
	const rowA = page.getByTestId('fix-worker').first();
	await rowA.getByTestId('fix-rename-open').click();
	await rowA.getByTestId('fix-rename').getByRole('textbox').fill('Suresh Yadav');
	await rowA.getByRole('button', { name: 'Save name' }).click();
	await expect(page.getByTestId('fix-worker').first()).toContainText('Suresh Yadav');
	await expect(page.getByTestId('fix-worker').first().getByRole('status')).toHaveText(
		'Name saved: Suresh Yadav'
	);
	expect((await db.query('SELECT name, named_by FROM persons WHERE id = $1', [a])).rows[0]).toEqual(
		{ name: 'Suresh Yadav', named_by: 'plant-manager' }
	);

	// Counted twice: B is the same person as A in the start photo, then undone.
	const rowA2 = page.getByTestId('fix-worker').first();
	await rowA2.getByRole('button', { name: 'Counted twice?' }).click();
	await rowA2.getByLabel('The same person as').selectOption(b);
	await rowA2.getByLabel('How did you check?').fill('Same face twice in the start photo');
	await rowA2.getByRole('button', { name: 'Remove the extra count' }).click();
	await expect(page.getByText(/counted twice, kept as Suresh Yadav/).first()).toBeVisible();
	expect(
		await count(
			`SELECT 1 FROM attendance_duplicate_resolutions WHERE duplicate_person_id = $1
			   AND resolved_by_manager_id = $2 AND resolved_by_admin_id IS NULL AND reversed_at IS NULL`,
			[b, manager.id]
		)
	).toBe(1);
	expect(
		await count(
			`SELECT 1 FROM daily_person_attendance WHERE person_id = $1 AND session_date = $2
			   AND morning_matched`,
			[b, day]
		)
	).toBe(0);
	await shots(page, '2-counted-twice', testInfo);
	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByText(/counted twice, kept as/).first()).toContainText('(undone)');
	expect(
		await count(
			`SELECT 1 FROM daily_person_attendance WHERE person_id = $1 AND session_date = $2
			   AND morning_matched`,
			[b, day]
		)
	).toBe(1);

	// A worker the camera missed.
	await page.getByLabel('Name', { exact: true }).fill('Kamal Singh');
	await page.getByRole('button', { name: 'Add and mark present' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Kamal Singh added' })).toBeVisible();
	await expect(page.getByTestId('fix-worker')).toHaveCount(3);
	expect(
		await count(
			`SELECT 1 FROM persons WHERE pump_id = $1 AND name = 'Kamal Singh' AND named_by = 'plant-manager'`,
			[pump.id]
		)
	).toBe(1);
	expect(
		await count(
			`SELECT 1 FROM admin_audit_log WHERE action = 'mark_present' AND admin_id IS NULL
			   AND details->'by'->>'id' = $1`,
			[manager.id]
		)
	).toBe(1);

	// The face popup on the shift card renames too. The stub AI saves no face crops, so the face
	// borrows the group photo; only an opened face has the popup.
	await db.query(
		`UPDATE attendance_face_evidence afe SET face_crop_url = s.photo_url
		 FROM attendance_sessions s WHERE s.id = afe.session_id AND afe.person_id = $1`,
		[a]
	);
	await page.goto(`/plant-manager/attendance?pump=${pump.id}&from=${day}&to=${day}`);
	await page.waitForLoadState('networkidle');
	await page.getByTestId('worker-chip').filter({ hasText: 'Suresh Yadav' }).first().click();
	const popup = page.getByTestId('popup-rename');
	await expect(popup.getByRole('textbox')).toHaveValue('Suresh Yadav');
	await popup.getByRole('textbox').fill('Suresh Kumar Yadav');
	await popup.getByRole('button', { name: 'Save name' }).click();
	await expect(popup.getByRole('status')).toHaveText('Name saved: Suresh Kumar Yadav');
	await shots(page, '3-popup-rename', testInfo);

	// The People page renames too (pencil, then Save).
	await page.goto('/plant-manager/people');
	await page.getByRole('button', { name: /Edit name of .*Suresh Kumar Yadav/ }).click();
	await page.getByTestId('rename-input').fill('Suresh Y');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByTestId('people-table')).toContainText('Suresh Y');
	expect((await db.query('SELECT name FROM persons WHERE id = $1', [a])).rows[0].name).toBe(
		'Suresh Y'
	);
	expect(
		await count(
			`SELECT 1 FROM admin_audit_log WHERE action = 'rename_person' AND target_id = $1
			   AND admin_id IS NULL`,
			[a]
		)
	).toBe(3);

	// Another plant's manager: no page, no action, no rename.
	const { plantId: otherPlant } = await createArea();
	const stranger = await login((await createPlantManager(otherPlant)).email);
	expect((await stranger.get(fixUrl)).status()).toBe(404);
	expect(
		await action(stranger, `/plant-manager/attendance/correct?/rename&pump=${pump.id}&day=${day}`, {
			person_id: a,
			name: 'Not Allowed'
		})
	).toMatchObject({ type: 'failure' });
	expect(
		await action(
			stranger,
			`/plant-manager/attendance/correct?/markDuplicate&pump=${pump.id}&day=${day}`,
			{
				person_id: a,
				duplicate_person_id: b,
				pump_id: pump.id,
				day,
				session_type: 'morning',
				duplicate_reason: 'trying another plant'
			}
		)
	).toMatchObject({ type: 'failure' });
	expect(
		(await stranger.post(`/api/persons/${a}/name`, { data: { name: 'Not Allowed' } })).status()
	).toBe(404);
	expect((await db.query('SELECT name FROM persons WHERE id = $1', [a])).rows[0].name).toBe(
		'Suresh Y'
	);
});
