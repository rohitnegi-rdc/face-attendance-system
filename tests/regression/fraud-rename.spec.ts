// FRD-15: after the admin marks a flag Not fraud, the card stays first and shows a name box for
// the worker marked present at the flagged pump. A new worker made by Not fraud has no name, so
// the box is empty and asks for one; Save name renames in place (audited), and the box then
// shows the name for a later correction.
import { test, expect, type Page } from '@playwright/test';
import {
	createAdmin,
	createArea,
	createPump,
	count,
	db,
	login,
	PASSWORD,
	photo,
	recordSession,
	submit,
	waitForSession
} from './helpers';

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

test('FRD-15 name the worker right after Not fraud', async ({ page }, testInfo) => {
	const { plantId } = await createArea();
	const a = await createPump(plantId);
	const b = await createPump(plantId);
	const identity = `FRD15-${b.code}`;
	await recordSession(await login(a.email), [identity]);
	const submitted = await submit(await login(b.email), await photo([identity]));
	expect(submitted.status).toBe(202);
	await waitForSession(submitted.body.session_id, ['review']);
	const { rows } = await db.query('SELECT id FROM fraud_flags WHERE session_id = $1', [
		submitted.body.session_id
	]);
	expect(rows).toHaveLength(1);

	const admin = await createAdmin();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/login');
	await page.getByTestId('login-email').fill(admin.email);
	await page.getByTestId('login-password').fill(PASSWORD);
	await page.getByTestId('login-submit').click();
	await page.waitForURL((url) => !url.pathname.startsWith('/login'));

	await page.goto('/admin/fraud-flags');
	const card = page.locator('article.review-item', { hasText: b.code }).first();
	await expect(card).toBeVisible();
	await expect(card.getByTestId('fraud-rename')).toHaveCount(0);
	await card.getByRole('button', { name: /Not fraud, mark present/ }).click();

	// The card is first, cleared, with an empty name box for the new worker.
	await expect(page.getByRole('status').first()).toContainText('Give them a name on the card');
	const first = page.locator('article.review-item').first();
	await expect(first).toContainText(b.code);
	const box = first.getByTestId('fraud-rename');
	await expect(box).toContainText(`Give this worker at ${b.code} a name`);
	const input = box.getByRole('textbox');
	await expect(input).toHaveValue('');
	await shots(page, '1-not-fraud-name-box', testInfo);

	await input.fill('Ramesh Kumar');
	await box.getByRole('button', { name: 'Save name' }).click();
	await expect(box.getByRole('status')).toHaveText('Name saved: Ramesh Kumar');
	await shots(page, '2-name-saved', testInfo);

	const { rows: person } = await db.query(
		`SELECT p.id, p.name FROM fraud_flags ff JOIN persons p ON p.id = ff.resolved_person_id
		 WHERE ff.id = $1`,
		[rows[0].id]
	);
	expect(person[0].name).toBe('Ramesh Kumar');
	expect(
		await count(`SELECT 1 FROM admin_audit_log WHERE action = 'rename_person' AND target_id = $1`, [
			person[0].id
		])
	).toBe(1);

	// Opened later, the box shows the name, ready for a correction.
	await page.goto('/admin/fraud-flags');
	const more = page.getByRole('button', { name: /^Show \d+ more/ });
	while (await more.isVisible()) await more.click();
	const later = page
		.locator('article.review-item', { hasText: b.code })
		.first()
		.getByTestId('fraud-rename');
	await expect(later).toContainText(`Name of this worker at ${b.code}`);
	await expect(later.getByRole('textbox')).toHaveValue('Ramesh Kumar');
});
