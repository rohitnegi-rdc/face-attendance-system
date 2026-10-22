// NAV and UI-09: side navigation badges (new attendance, fraud), the fraud highlight in the
// session logs, and every worker shown inline next to the group photo.
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
	createAdmin,
	createArea,
	createPlantManager,
	createPump,
	createVendor,
	db,
	login,
	photo,
	recordSession,
	submit,
	waitForSession
} from './helpers';

async function html(context: APIRequestContext, path: string) {
	const response = await context.get(path);
	expect(response.status(), path).toBe(200);
	return response.text();
}

// The badge's number, or null when there is no badge.
function badge(page: string, key: string) {
	const match = page.match(new RegExp(`data-testid="nav-badge-${key}"[^>]*>([^<]+)<`));
	return match ? match[1].trim() : null;
}

async function submitAndWait(context: APIRequestContext, faces: Parameters<typeof photo>[0]) {
	const submitted = await submit(context, await photo(faces));
	expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
	await waitForSession(submitted.body.session_id, ['review']);
	return submitted.body.session_id as string;
}

test('NAV-01 a new shift photo shows on the Attendance badge until the page is opened', async () => {
	const { plantId } = await createArea();
	const vendor = await createVendor();
	const pump = await createPump(plantId, vendor.id);
	const manager = await login((await createPlantManager(plantId)).email);
	const owner = await login(vendor.email);

	// First visit ever: nothing new yet.
	expect(badge(await html(manager, '/plant-manager'), 'attendance')).toBeNull();
	await submitAndWait(await login(pump.email), ['NAV01']);

	expect(badge(await html(manager, '/plant-manager'), 'attendance')).toBe('1');
	expect(badge(await html(owner, '/vendor'), 'attendance')).toBe('1');

	// Opening Attendance clears it, on that page and afterwards.
	expect(badge(await html(manager, '/plant-manager/attendance'), 'attendance')).toBeNull();
	expect(badge(await html(manager, '/plant-manager'), 'attendance')).toBeNull();
	// Each user has their own marker: the vendor has not looked yet.
	expect(badge(await html(owner, '/vendor'), 'attendance')).toBe('1');

	// The admin sees every pump; other tests add photos too, so only check it is there.
	const admin = await login((await createAdmin()).email);
	expect(badge(await html(admin, '/admin'), 'attendance')).not.toBeNull();
	expect(badge(await html(admin, '/admin/attendance'), 'attendance')).toBeNull();
});

test('NAV-02 cross-pump fraud lights the badges and highlights both sessions', async () => {
	const { plantId } = await createArea();
	const a = await createPump(plantId);
	const b = await createPump(plantId);
	const manager = await login((await createPlantManager(plantId)).email);
	await recordSession(await login(a.email), ['NAV02']);
	const flaggedSession = await submitAndWait(await login(b.email), ['NAV02']);
	const { rows } = await db.query('SELECT id FROM fraud_flags WHERE session_id = $1', [
		flaggedSession
	]);
	expect(rows).toHaveLength(1);

	// Plant manager: red Approvals badge, the case listed on Approvals.
	const overview = await html(manager, '/plant-manager');
	expect(Number(badge(overview, 'approvals'))).toBeGreaterThanOrEqual(1);
	expect(overview).toMatch(/nav-badge--alert[^>]*data-testid="nav-badge-approvals"/);
	const approvals = await html(manager, '/plant-manager/approvals');
	expect(approvals).toContain('data-testid="pm-fraud"');
	expect(approvals.split('data-testid="pm-fraud"')[1]).toContain(a.code);

	// Session log: both rows red, each naming the other pump, the refused face shown inline.
	const log = await html(manager, '/plant-manager/attendance');
	expect(log).toContain(`Same person at ${a.code}`);
	expect(log).toContain(`Same person at ${b.code}`);
	expect(log).toContain('data-testid="fraud-face"');
	expect(log).toMatch(/<tr class="[^"]*row-fraud/);

	// Admin: Fraud flags badge, and the same highlight on both pump pages.
	const admin = await login((await createAdmin()).email);
	expect(badge(await html(admin, '/admin'), 'fraud')).not.toBeNull();
	expect(await html(admin, `/admin/pumps/${b.id}`)).toContain(`Same person at ${a.code}`);
	expect(await html(admin, `/admin/pumps/${a.id}`)).toContain(`Same person at ${b.code}`);
});

test('NAV-03 a fraud case an admin cleared stops counting and is no longer red', async () => {
	const { plantId } = await createArea();
	const a = await createPump(plantId);
	const b = await createPump(plantId);
	const manager = await login((await createPlantManager(plantId)).email);
	await recordSession(await login(a.email), ['NAV03']);
	const flaggedSession = await submitAndWait(await login(b.email), ['NAV03']);
	await db.query(
		`UPDATE fraud_flags SET reviewed = true, resolution = 'not_fraud', resolved_at = now()
		 WHERE session_id = $1`,
		[flaggedSession]
	);

	expect(badge(await html(manager, '/plant-manager'), 'approvals')).toBeNull();
	expect(await html(manager, '/plant-manager/approvals')).not.toContain('data-testid="pm-fraud"');
	const log = await html(manager, '/plant-manager/attendance');
	expect(log).not.toContain('Same person at');
	// Still visible as a grey "Cleared" tile, for the record.
	expect(log).toContain('data-testid="fraud-face"');
	expect(log).toContain('Cleared');
});

test('UI-09 every worker of a session is shown inline, no fold-out list', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const manager = await login((await createPlantManager(plantId)).email);
	await recordSession(
		await login(pump.email),
		['G1', 'G2', 'G3', 'G4', 'G5'].map((g) => `UI09${g}`)
	);
	const page = await html(manager, '/plant-manager/attendance');
	expect(page).not.toMatch(/<summary>\d+ workers<\/summary>/);
	const evidence = (page.split('data-testid="evidence-people"')[1] ?? '').split('</div>')[0];
	// Five workers; the operator is one of them or one more face. The stub AI returns no crops,
	// so the tiles here are the "photo unavailable" kind; real photos give clickable ones.
	const tiles = evidence.match(/class="face-tile[^"]*"[^>]*title="Worker \d+/g) ?? [];
	expect(tiles.length).toBeGreaterThanOrEqual(5);
});
