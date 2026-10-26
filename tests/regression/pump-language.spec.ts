// UI-08: the pump screen is in Hindi by default; one toggle switches to English and the choice
// stays after a reload. The first step is the operator photo.
import { test, expect } from '@playwright/test';
import { BASE_URL, PASSWORD, createArea, createPump, openPumpScreen } from './helpers';

test('UI-08 pump screen starts in Hindi, the toggle switches to English and is remembered', async ({
	page
}) => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const response = await page.request.post('/api/auth/login', {
		data: { email: pump.email, password: PASSWORD },
		headers: { origin: BASE_URL }
	});
	expect(response.status()).toBe(200);

	await openPumpScreen(page);
	const toggle = page.getByTestId('lang-toggle');
	await expect(toggle).toHaveAttribute('aria-checked', 'true');
	await expect(page.getByText('शिफ्ट की जानकारी')).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'पंप ऑपरेटर फोटो लें', exact: true })
	).toBeVisible();
	// The operator photo comes first; the group photo step opens only after it.
	await expect(page.getByTestId('group-photo')).toHaveCount(0);

	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-checked', 'false');
	await expect(page.getByText('Shift details')).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Take Pump Operator photo', exact: true })
	).toBeVisible();

	await page.reload();
	await expect(page.getByText('Shift details')).toBeVisible();
	await expect(page.getByTestId('lang-toggle')).toHaveAttribute('aria-checked', 'false');
});
