// UI-13: a new pump's first visit opens the guide, which cannot be closed (no close button,
// Escape does nothing) and switches between Hindi and English. Finishing it is saved on the
// server, so it does not open again; the Help button reopens it, and from there it closes.
import { test, expect } from '@playwright/test';
import { BASE_URL, PASSWORD, createArea, createPump, db } from './helpers';

test('UI-13 first sign-in guide cannot be skipped, switches language, Help reopens it', async ({
	page
}) => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId, undefined, { guideDone: false });
	const response = await page.request.post('/api/auth/login', {
		data: { email: pump.email, password: PASSWORD },
		headers: { origin: BASE_URL }
	});
	expect(response.status()).toBe(200);

	await page.goto('/pump');
	const guide = page.getByTestId('pump-guide');
	await expect(guide).toBeVisible();
	await expect(guide).toHaveAttribute('data-forced', 'true');
	await expect(page.getByTestId('guide-close')).toHaveCount(0);
	await expect(page.getByTestId('guide-title')).toHaveText('पंप ऑपरेटर की फोटो अपलोड करें');
	await page.keyboard.press('Escape');
	await expect(guide).toBeVisible();

	await page.getByTestId('guide-lang').click();
	await expect(page.getByTestId('guide-title')).toHaveText('Upload the Pump Operator photo');
	await expect(guide.getByText('Take Pump Operator photo').first()).toBeVisible();

	const next = page.getByTestId('guide-next');
	for (let step = 1; step < 6; step++) await next.click();
	await expect(page.getByTestId('guide-title')).toHaveText('Close the shift');
	await expect(next).toHaveText(/Start/);
	await next.click();
	await expect(guide).toHaveCount(0);
	await expect
		.poll(async () => {
			const { rows } = await db.query('SELECT guide_done_at FROM pumps WHERE id = $1', [pump.id]);
			return rows[0].guide_done_at !== null;
		})
		.toBe(true);

	await page.reload();
	await expect(
		page.getByRole('button', { name: 'Take Pump Operator photo', exact: true })
	).toBeVisible();
	await expect(guide).toHaveCount(0);

	await page.getByTestId('guide-help').click();
	await expect(guide).toHaveAttribute('data-forced', 'false');
	await page.getByTestId('guide-close').click();
	await expect(guide).toHaveCount(0);
});
