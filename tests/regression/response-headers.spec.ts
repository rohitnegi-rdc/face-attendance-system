// OPS-09: page responses stay under nginx's 4 KB response header limit. SvelteKit's `link` preload
// header grew past it on a monitor's Attendance page and nginx answered 502 (2026-11-13), so the
// app drops that header (hooks.server.ts); the page keeps its own preload tags.
import { expect, test } from '@playwright/test';
import { createAdmin, createArea, createPlantManager, db } from './helpers';
import { signIn } from './regularisationHelpers';

const LIMIT = 4096;
const headerBytes = (headers: Record<string, string>) =>
	Object.entries(headers).reduce((n, [k, v]) => n + k.length + v.length + 4, 0);

test('OPS-09 page headers have no link list and stay under 4 KB', async ({ page }) => {
	const admin = await createAdmin();
	const { areaId, plantId } = await createArea();
	const monitor = await createPlantManager(plantId);
	await db.query('UPDATE plant_managers SET is_monitor = true WHERE id = $1', [monitor.id]);
	await db.query('INSERT INTO monitor_areas (manager_id, area_id) VALUES ($1, $2)', [
		monitor.id,
		areaId
	]);

	const pages: [string, string[]][] = [
		[
			monitor.email,
			['/plant-manager/attendance', '/plant-manager/pumps', '/plant-manager/regularisations']
		],
		[admin.email, ['/admin', '/admin/attendance', `/admin/areas/${areaId}`]]
	];
	for (const [email, paths] of pages) {
		await page.context().clearCookies();
		await signIn(page, email);
		for (const path of paths) {
			const response = await page.goto(path);
			expect(response?.status(), path).toBe(200);
			const headers = await response!.allHeaders();
			expect(headers.link, path).toBeUndefined();
			expect(headerBytes(headers), path).toBeLessThan(LIMIT);
		}
	}
});
