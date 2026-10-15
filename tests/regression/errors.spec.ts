// ERR: what the user sees when the system fails. A server error or a lost connection must show
// the "Something went wrong. Please contact Admin." toast (or the error page for a full page
// load), never a blank or stuck screen, and never internal details.
import { test, expect, type Page } from '@playwright/test';
import { BASE_URL, PASSWORD, createAdmin, createArea, createPump } from './helpers';

const CONTACT_ADMIN = 'Something went wrong. Please contact Admin.';

async function signIn(page: Page, email: string) {
	const response = await page.request.post('/api/auth/login', {
		data: { email, password: PASSWORD },
		headers: { origin: BASE_URL }
	});
	expect(response.status()).toBe(200);
}

test('ERR-01 a server error on an API call shows the contact-admin toast on the pump screen', async ({
	page
}) => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	await signIn(page, pump.email);
	await page.route('**/api/attendance/today', (route) =>
		route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
	);

	await page.goto('/pump');
	const toast = page.getByTestId('error-toast');
	await expect(toast).toBeVisible();
	await expect(toast).toContainText(CONTACT_ADMIN);
	await expect(page.getByTestId('status-failed')).toBeVisible();
});

test('ERR-02 a lost connection shows the toast instead of leaving the pump screen stuck', async ({
	page
}) => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	await signIn(page, pump.email);
	await page.route('**/api/attendance/today', (route) => route.abort('internetdisconnected'));

	await page.goto('/pump');
	await expect(page.getByTestId('error-toast')).toContainText(CONTACT_ADMIN);
	await expect(page.getByTestId('error-toast')).toContainText('could not be reached');
	await expect(page.getByTestId('status-failed')).toBeVisible();
});

test('ERR-03 an unexpected server exception shows the error page with a reference, no internals', async ({
	page
}) => {
	const admin = await createAdmin();
	await signIn(page, admin.email);

	// Not a valid id: the database rejects it and nothing in the route catches that.
	const response = await page.goto('/admin/pumps/not-a-valid-id');
	expect(response?.status()).toBe(500);
	await expect(page.getByTestId('error-page')).toContainText(CONTACT_ADMIN);
	await expect(page.getByTestId('error-ref')).toHaveText(/^[0-9a-f]{8}$/);
	await expect(page.locator('body')).not.toContainText(/uuid|syntax|stack|at .*\.js/i);
});

test('ERR-04 the data request behind a failing page carries the contact-admin message, no internals', async ({
	page
}) => {
	const admin = await createAdmin();
	await signIn(page, admin.email);
	const response = await page.request.get('/admin/pumps/not-a-valid-id/__data.json');
	const body = await response.text();
	expect(body).toContain(CONTACT_ADMIN);
	expect(body).not.toMatch(/invalid input syntax|uuid/i);
});

test('ERR-05 a missing page says so, without the contact-admin alarm', async ({ page }) => {
	const response = await page.goto('/no-such-page');
	expect(response?.status()).toBe(404);
	await expect(page.getByTestId('error-page')).toContainText('Page not found');
	await expect(page.getByTestId('error-toast')).toHaveCount(0);
});
