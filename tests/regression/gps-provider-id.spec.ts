// LOC-14 / LOC-15: a pump keeps its login while its GPS tracker reports under another name
// (2026-11-18: "I want the PUMPMU6 GPS to be of MULP6SST ... but I want the same the login Id").
// The admin sets the pump's GPS provider id; the worker gives that pump the feed positions even
// when another pump's code is that name; the pump page shows where its GPS comes from, how old
// the last position is and what happens next; every change is audited.
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
	action,
	createAdmin,
	createArea,
	createPlantManager,
	createPump,
	db,
	login
} from './helpers';
import { noSidewaysScroll, signIn } from './regularisationHelpers';

const audits = async (pumpId: string) =>
	(
		await db.query(
			`SELECT details FROM admin_audit_log WHERE action = 'set_gps_device_id' AND target_id = $1
			 ORDER BY created_at`,
			[pumpId]
		)
	).rows.map((r) => r.details);

test('LOC-14 the GPS provider id wins over another pump whose code is that name', async () => {
	test.skip(!process.env.REGRESSION_OUTPUT_DIR, 'needs the workers from run-regression');
	const { plantId } = await createArea();
	const renamed = await createPump(plantId); // keeps its login, tracker reports as `namesake.code`
	const namesake = await createPump(plantId);
	await db.query('UPDATE pumps SET gps_device_id = $1 WHERE id = $2', [
		namesake.code.toLowerCase(),
		renamed.id
	]);
	await db.query(
		`INSERT INTO dump.pump_events (pump_id, latitude, longitude, event_timestamp)
		 VALUES ($1, '19.2614', '73.1658', date_trunc('second', now()) - interval '2 minutes')`,
		[namesake.code]
	);
	const rows = async (pumpId: string) =>
		(await db.query('SELECT lat FROM pump_locations WHERE pump_id = $1', [pumpId])).rows;
	await expect.poll(async () => (await rows(renamed.id)).length, { timeout: 20_000 }).toBe(1);
	expect((await rows(renamed.id))[0].lat).toBe(19.2614);
	expect(await rows(namesake.id)).toEqual([]);
});

test('LOC-15 an admin points a pump at its tracker name; the page shows the GPS and it is audited', async ({
	page
}) => {
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(String(e)));
	page.on('console', (m) => {
		if (m.type() === 'error') problems.push(m.text());
	});
	const admin = await createAdmin();
	const { areaId, plantId } = await createArea();
	await db.query('UPDATE areas SET location_check_enabled = true WHERE id = $1', [areaId]);
	const pump = await createPump(plantId);
	const tracker = `TRK${randomUUID().slice(0, 8).toUpperCase()}`;

	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, admin.email);
	await page.goto(`/admin/pumps/${pump.id}`);
	// No GPS yet: said in red, with what happens next.
	await expect(page.getByTestId('gps-source')).toContainText(`${pump.code} the pump code`);
	await expect(page.getByTestId('gps-last')).toContainText('No GPS received');
	await expect(page.getByTestId('gps-next')).toContainText(
		`Shift starts wait for the plant manager's approval until a position under 30 minutes old arrives from ${pump.code}.`
	);

	await page.getByTestId('gps-device-id').fill(` ${tracker} `);
	await page.getByRole('button', { name: 'Save id' }).click();
	await expect(page.getByRole('status')).toContainText(
		`GPS now comes from ${tracker}. Its next position arrives within 5 minutes.`
	);
	const { rows } = await db.query('SELECT pump_code, gps_device_id FROM pumps WHERE id = $1', [
		pump.id
	]);
	expect(rows[0]).toEqual({ pump_code: pump.code, gps_device_id: tracker }); // login unchanged
	expect(await audits(pump.id)).toEqual([{ pump: pump.code, from: null, to: tracker }]);

	// A position from the feed arrives: fresh, with its age; the warning goes.
	await db.query(
		`INSERT INTO pump_locations (pump_id, lat, lng, recorded_at, source)
		 VALUES ($1, 19.2614, 73.1658, now() - interval '3 minutes', 'gps_api')`,
		[pump.id]
	);
	await page.reload();
	await expect(page.getByTestId('gps-source')).toContainText(
		`${tracker} GPS provider id; the login stays ${pump.code}`
	);
	await expect(page.getByTestId('gps-last')).toContainText('Fresh');
	await expect(page.getByTestId('gps-last')).toContainText('(3 min ago)');
	await expect(page.getByTestId('gps-last')).toContainText('from the GPS feed');
	await expect(page.getByTestId('gps-count')).toContainText('1');
	await expect(page.getByTestId('gps-next')).toHaveCount(0);
	const section = page.getByRole('region', { name: 'Pump GPS' });
	await section.scrollIntoViewIfNeeded();
	await noSidewaysScroll(page);
	await section.screenshot({ path: 'artifacts/deep-build/screenshots/pump-gps-mobile.png' });

	// An old position: "Too old" and the next step again.
	await db.query(
		`UPDATE pump_locations SET recorded_at = now() - interval '2 hours 5 minutes' WHERE pump_id = $1`,
		[pump.id]
	);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.reload();
	await expect(page.getByTestId('gps-last')).toContainText('Too old');
	await expect(page.getByTestId('gps-last')).toContainText('(2 h 5 min ago)');
	await expect(page.getByTestId('gps-next')).toContainText(`arrives from ${tracker}`);
	await section.scrollIntoViewIfNeeded();
	await section.screenshot({ path: 'artifacts/deep-build/screenshots/pump-gps-desktop.png' });

	// Saving the same id again changes nothing; clearing it goes back to the pump code, audited.
	await page.getByTestId('gps-device-id').fill(tracker);
	await page.getByRole('button', { name: 'Save id' }).click();
	await expect(page.getByRole('status')).toContainText('No change.');
	await page.getByTestId('gps-device-id').fill('');
	await page.getByRole('button', { name: 'Save id' }).click();
	await expect(page.getByRole('status')).toContainText(
		`GPS id cleared: GPS comes from ${pump.code} again.`
	);
	expect(await audits(pump.id)).toEqual([
		{ pump: pump.code, from: null, to: tracker },
		{ pump: pump.code, from: tracker, to: null }
	]);
	expect(problems).toEqual([]);
});

test('LOC-15 naming another pump says it loses those positions; a used id is refused', async () => {
	const admin = await login((await createAdmin()).email);
	const { plantId } = await createArea();
	const [first, second, third] = await Promise.all([
		createPump(plantId),
		createPump(plantId),
		createPump(plantId)
	]);
	const saved = await admin.post(`/admin/pumps/${first.id}?/setGpsDeviceId`, {
		form: { gps_device_id: second.code },
		headers: { accept: 'application/json', 'x-sveltekit-action': 'true' }
	});
	const body = await saved.json();
	expect(body.type).toBe('success');
	expect(body.data).toContain(`Pump ${second.code} no longer gets these positions.`);

	// The same tracker name on a second pump is refused and nothing changes.
	const refused = await action(admin, `/admin/pumps/${third.id}?/setGpsDeviceId`, {
		gps_device_id: second.code.toLowerCase()
	});
	expect(refused.type).toBe('failure');
	expect(refused.status).toBe(409);
	const { rows } = await db.query('SELECT gps_device_id FROM pumps WHERE id = $1', [third.id]);
	expect(rows[0].gps_device_id).toBeNull();
	expect(await audits(third.id)).toEqual([]);
});

test('LOC-15 only an admin can change a GPS provider id', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const manager = await login((await createPlantManager(plantId)).email);
	const response = await action(manager, `/admin/pumps/${pump.id}?/setGpsDeviceId`, {
		gps_device_id: 'SNEAKY'
	});
	expect(response.type).not.toBe('success');
	const { rows } = await db.query('SELECT gps_device_id FROM pumps WHERE id = $1', [pump.id]);
	expect(rows[0].gps_device_id).toBeNull();
});
