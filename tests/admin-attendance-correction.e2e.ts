import { expect, test } from '@playwright/test';

test('admin can correct a missed worker from the attendance evidence', async ({ page }, testInfo) => {
	await page.goto('/login');
	await page.getByTestId('login-email').fill('admin@attendance.local');
	await page.getByTestId('login-password').fill('Admin1234!');
	await page.getByTestId('login-submit').click();
	await expect(page).toHaveURL(/\/admin\/?$/);

	await page.goto('/admin/attendance');
	const correctionLink = page.getByRole('link', { name: 'Correct attendance' }).first();
	await expect(correctionLink).toBeVisible();
	await correctionLink.click();

	await expect(page.getByRole('heading', { name: 'Correct attendance' })).toBeVisible();
	await expect(page.getByText('Source photos')).toBeVisible();
	await expect(page.getByTestId('attendance-correction-roster')).toBeVisible();
	await expect(page.getByTestId('attendance-correction-row').first().locator('img')).toBeVisible();

	const firstRow = page.getByTestId('attendance-correction-row').first();
	const morning = firstRow.getByRole('checkbox', { name: 'Morning present' });
	const originalMorning = await morning.isChecked();
	await morning.setChecked(!originalMorning);
	await firstRow.getByLabel('Correction reason').fill('Verified manually from the group photo');
	await firstRow.getByRole('button', { name: 'Save correction' }).click();

	await expect(page.getByRole('status')).toContainText('Attendance correction saved');
	await expect(morning).toBeChecked({ checked: !originalMorning });
	await page.screenshot({
		path: `test-output/attendance-correction/${testInfo.project.name}-attendance-correction.png`,
		fullPage: true
	});

	// Restore the fixture through the same audited workflow so repeated runs stay deterministic.
	await morning.setChecked(originalMorning);
	await firstRow.getByLabel('Correction reason').fill('Restored after automated verification');
	await firstRow.getByRole('button', { name: 'Save correction' }).click();
	await expect(page.getByRole('status')).toContainText('Attendance correction saved');

	const refreshedRows = page.getByTestId('attendance-correction-row');
	const keptRow = refreshedRows.first();
	const duplicateRow = refreshedRows.nth(1);
	const keptMorning = keptRow.getByRole('checkbox', { name: 'Morning present' });
	const duplicateMorning = duplicateRow.getByRole('checkbox', { name: 'Morning present' });
	const originalKeptMorning = await keptMorning.isChecked();
	const originalDuplicateMorning = await duplicateMorning.isChecked();
	await keptRow.getByText('Resolve duplicate detection').click();
	await keptRow.getByLabel('Duplicate of').selectOption({ index: 1 });
	await keptRow.getByLabel('Duplicate reason').fill('Same worker verified twice in the morning source photo');
	await keptRow.scrollIntoViewIfNeeded();
	await keptRow.getByRole('button', { name: 'Mark duplicate' }).click();
	await expect(page.getByRole('status')).toContainText('Duplicate detection removed');
	try {
		await expect(page.getByTestId('attendance-correction-row').first().getByRole('checkbox', { name: 'Morning present' })).toBeChecked();
		const markedDuplicate = page.getByTestId('attendance-correction-row').nth(1);
		await expect(markedDuplicate.locator('.duplicate-state')).toContainText('Morning: duplicate of');
		await expect(markedDuplicate.getByRole('button', { name: 'Unmark' })).toBeVisible();
		expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
		await expect(page.getByTestId('duplicate-history-entry').first()).toContainText('morning duplicate');
		await page.screenshot({
			path: `test-output/attendance-correction/${testInfo.project.name}-duplicate-state.png`,
			fullPage: true
		});
	} finally {
		await page.getByTestId('attendance-correction-row').nth(1).getByRole('button', { name: 'Unmark' }).click();
	}
	await expect(page.getByRole('status')).toContainText('previous attendance restored');
	expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
	await expect(page.getByTestId('attendance-correction-row').first().getByRole('checkbox', { name: 'Morning present' })).toBeChecked({ checked: originalKeptMorning });
	await expect(page.getByTestId('attendance-correction-row').nth(1).getByRole('checkbox', { name: 'Morning present' })).toBeChecked({ checked: originalDuplicateMorning });
	await expect(page.getByTestId('duplicate-history-entry').first()).toContainText('Undone');
});
