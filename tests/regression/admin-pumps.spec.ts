// UI-16: the admin has a Pumps page in the side menu, searchable by pump code, plant, area or
// vendor, and each pump opens its own page (where Clear test records lives) and resets its
// password. UI-17: the Vendors page has the same search.
import { expect, test } from '@playwright/test';
import { createAdmin, createArea, createPump, createVendor, db, login } from './helpers';

test('UI-16 the admin finds a pump by code or plant and opens its page', async () => {
	const { plantId } = await createArea();
	const first = await createPump(plantId);
	const second = await createPump(plantId);
	const { plantId: otherPlant } = await createArea();
	const other = await createPump(otherPlant);
	const plantName = (await db.query('SELECT name FROM plants WHERE id = $1', [plantId])).rows[0]
		.name as string;

	const admin = await login((await createAdmin()).email);
	const list = async (q: string) => {
		const response = await admin.get(`/admin/pumps?q=${encodeURIComponent(q)}`);
		expect(response.status()).toBe(200);
		return response.text();
	};

	const all = await (await admin.get('/admin/pumps')).text();
	expect(all).toContain('href="/admin/pumps"');
	expect(all).toContain('data-testid="pump-search"');

	// By pump code (any case): only that pump, linked to its page.
	const byCode = await list(first.code.toLowerCase());
	expect(byCode).toContain(`href="/admin/pumps/${first.id}"`);
	expect(byCode).not.toContain(second.code);
	expect(byCode).toMatch(/data-testid="pump-total"[^>]*>\s*1\s+pump\b/);

	// By plant name: both pumps of that plant, not the other plant's.
	const byPlant = await list(plantName);
	expect(byPlant).toContain(first.code);
	expect(byPlant).toContain(second.code);
	expect(byPlant).not.toContain(other.code);

	expect(await list('no-such-pump-xyz')).toContain('No pump matches');
	expect((await admin.get(`/admin/pumps/${first.id}`)).status()).toBe(200);

	// Each row resets its pump's password, next to Status (PWD-09 checks the reset itself).
	expect(byCode).toMatch(/<th>Status<\/th>\s*<th>Password<\/th>/);
	expect(byCode).toContain('data-testid="admin-reset-pump-password"');
});

test('UI-17 the admin searches vendors by name, area or login', async () => {
	const vendor = await createVendor();
	const other = await createVendor();
	const name = (await db.query('SELECT name FROM vendors WHERE id = $1', [vendor.id])).rows[0]
		.name as string;
	const admin = await login((await createAdmin()).email);
	const list = async (q: string) =>
		(await admin.get(`/admin/vendors?q=${encodeURIComponent(q)}`)).text();

	expect(await (await admin.get('/admin/vendors')).text()).toContain('data-testid="vendor-search"');
	for (const q of [name.toLowerCase(), vendor.email]) {
		const html = await list(q);
		// Only the table rows: the New pump form's vendor list (page data) still has everyone.
		const rows = html.split('<tbody')[1].split('</tbody>')[0];
		expect(rows).toContain(vendor.email);
		expect(rows).not.toContain(other.email);
		expect(html).toMatch(/data-testid="vendor-total"[^>]*>\s*(<!--[^>]*-->)?\s*1 of \d+ logins/);
	}
	expect(await list('no-such-vendor-xyz')).toContain('No vendor matches');
});
