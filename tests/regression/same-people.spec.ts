// SAME-01: the camera did not know the shift-start crew at the end (each end face is close to a
// start face but under the match threshold, so all four became new workers). The shift card has
// no extra badge: Fix attendance asks of each new face who it is from the shift start, with the
// closest start face picked already. Merge joins the pairs: the day becomes a full shift and the
// end faces join the start worker's gallery. Admin and plant manager both.
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
	createAdmin,
	createArea,
	createPlantManager,
	createPump,
	count,
	db,
	login,
	PASSWORD,
	recordSession,
	shiftBack
} from './helpers';

const SCREENS = [
	{ name: '390', width: 390, height: 844 },
	{ name: '1440', width: 1440, height: 900 }
];

// A shift whose four workers are counted as four new ones at the end.
async function splitShift() {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const pumpContext = await login(pump.email);
	const crew = [1, 2, 3, 4].map((n) => `SAME${n}-${pump.code}`);
	const start = await recordSession(pumpContext, crew);
	await shiftBack(start, 600);
	const end = await recordSession(
		pumpContext,
		crew.map((identity) => ({ identity, similarity: 0.25 }))
	);
	const { rows } = await db.query(
		`SELECT s.session_type, array_agg(afe.person_id::text ORDER BY p.display_seq) AS ids,
		        min(s.session_date)::text AS day
		 FROM attendance_sessions s JOIN attendance_face_evidence afe ON afe.session_id = s.id
		 JOIN persons p ON p.id = afe.person_id
		 WHERE s.id = ANY($1) GROUP BY s.session_type`,
		[[start, end]]
	);
	const startIds: string[] = rows.find((r) => r.session_type === 'morning').ids;
	const endIds: string[] = rows.find((r) => r.session_type === 'evening').ids;
	expect(startIds).toHaveLength(4);
	expect(endIds).toHaveLength(4);
	expect(endIds.filter((id) => startIds.includes(id))).toHaveLength(0);
	return { pump, plantId, day: rows[0].day as string, startIds, endIds };
}

async function signIn(page: Page, email: string) {
	await page.goto('/login');
	await page.getByTestId('login-email').fill(email);
	await page.getByTestId('login-password').fill(PASSWORD);
	await page.getByTestId('login-submit').click();
	await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

// Full-page screenshots at phone and desktop width, with no sideways scrolling at either.
async function shots(page: Page, path: (name: string) => string, target?: Locator) {
	for (const screen of SCREENS) {
		await page.setViewportSize({ width: screen.width, height: screen.height });
		if (target) await target.scrollIntoViewIfNeeded();
		await page.screenshot({ path: path(screen.name), fullPage: true });
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow, `horizontal scroll at ${screen.name}px`).toBeLessThanOrEqual(0);
	}
	await page.setViewportSize({ width: 390, height: 844 });
}

async function fullShiftFor(ids: string[], day: string) {
	return count(
		`SELECT 1 FROM daily_person_attendance
		 WHERE person_id = ANY($1) AND session_date = $2 AND morning_matched AND evening_matched`,
		[ids, day]
	);
}

test('SAME-01 admin merges the suggested pairs; the shift becomes a full shift', async ({
	page
}, testInfo) => {
	const { pump, day, startIds, endIds } = await splitShift();
	const admin = await createAdmin();
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, admin.email);

	// The shift card has Fix attendance only; the question waits there.
	await page.goto(`/admin/pumps/${pump.id}`);
	const row = page.getByTestId('shift-row').first();
	await expect(row.getByTestId('same-people-badge')).toHaveCount(0);
	const fix = row.getByTestId('fix-attendance');
	await shots(page, (n) => testInfo.outputPath(`admin-1-card-${n}.png`), row);
	await fix.click();
	await page.waitForURL(/\/admin\/attendance\/correct\?/);

	// One question per new face at the end, its own start face picked already.
	const card = page.getByTestId('same-people');
	await expect(card).toBeVisible();
	await expect(card.getByTestId('same-pair')).toHaveCount(4);
	for (const [i, endId] of endIds.entries()) {
		await expect(card.locator(`input[name="pair_${endId}"][value="${startIds[i]}"]`)).toBeChecked();
	}
	const merge = page.getByTestId('same-merge');
	await expect(merge).toHaveText(/Save: 4 same people/);
	await shots(page, (n) => testInfo.outputPath(`admin-2-pairs-${n}.png`), card);

	await merge.click();
	await expect(
		page.getByRole('status').filter({ hasText: 'Saved. 4 people now count' })
	).toBeVisible();
	await expect(page.getByTestId('same-people')).toHaveCount(0);
	await shots(page, (n) => testInfo.outputPath(`admin-3-merged-${n}.png`));

	// Merged for real: end workers point at the start workers, who now have both halves; the
	// merges are logged (undo on the worker page) and the whole fix is audited once.
	expect(
		await count(
			`SELECT 1 FROM persons WHERE id = ANY($1) AND status = 'merged'
			   AND merged_into_person_id = ANY($2)`,
			[endIds, startIds]
		)
	).toBe(4);
	expect(await fullShiftFor(startIds, day)).toBe(4);
	expect(
		await count('SELECT 1 FROM daily_person_attendance WHERE person_id = ANY($1)', [endIds])
	).toBe(0);
	expect(
		await count(`SELECT 1 FROM person_merge_log WHERE kept_person_id = ANY($1) AND admin_id = $2`, [
			startIds,
			admin.id
		])
	).toBe(4);
	expect(
		await count(
			`SELECT 1 FROM admin_audit_log WHERE action = 'merge_same_people' AND target_id = $1`,
			[pump.id]
		)
	).toBe(1);

	// Back on the pump page the shift is a full shift.
	await page.goto(`/admin/pumps/${pump.id}`);
	await expect(page.getByTestId('shift-row').first()).toContainText('Full shift');
	await shots(page, (n) => testInfo.outputPath(`admin-4-full-shift-${n}.png`));
});

test('SAME-01 plant manager moves one pick, leaves one as Someone new and saves the rest', async ({
	page
}, testInfo) => {
	const { pump, plantId, day, startIds, endIds } = await splitShift();
	const manager = await createPlantManager(plantId);
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, manager.email);

	const log = `/plant-manager/attendance?pump=${pump.id}&from=${day}&to=${day}`;
	await page.goto(log);
	const fix = page.getByTestId('shift-row').first().getByTestId('fix-attendance');
	await shots(page, (n) => testInfo.outputPath(`pm-1-card-${n}.png`), fix);
	await fix.click();
	await page.waitForURL(/\/plant-manager\/attendance\/correct\?/);

	const card = page.getByTestId('same-people');
	const pairs = card.getByTestId('same-pair');
	const picked = (row: number, startId: string) =>
		card.locator(`input[name="pair_${endIds[row]}"][value="${startId}"]`);
	const tap = (row: number, startId: string) =>
		pairs.nth(row).locator(`label:has(input[value="${startId}"])`).click();
	await expect(pairs).toHaveCount(4);

	// Tapping the second start face on the first new face moves it there; the second new face
	// goes back to Someone new until it is given its face again.
	await tap(0, startIds[1]);
	await expect(picked(0, startIds[1])).toBeChecked();
	await expect(picked(1, '')).toBeChecked();
	await expect(page.getByTestId('same-merge')).toHaveText(/Save: 3 same people/);
	await shots(page, (n) => testInfo.outputPath(`pm-2-moved-${n}.png`), card);
	await tap(0, startIds[0]);
	await tap(1, startIds[1]);
	await expect(picked(0, startIds[0])).toBeChecked();
	await expect(picked(1, startIds[1])).toBeChecked();

	// The fourth new face really is someone new.
	await tap(3, '');
	await expect(picked(3, '')).toBeChecked();
	await expect(page.getByTestId('same-merge')).toHaveText(/Save: 3 same people/);
	await page.getByTestId('same-merge').click();
	await expect(
		page.getByRole('status').filter({ hasText: 'Saved. 3 people now count' })
	).toBeVisible();

	// One pair left apart, so the card stays for it.
	await expect(page.getByTestId('same-pair')).toHaveCount(1);
	await shots(page, (n) => testInfo.outputPath(`pm-3-one-left-${n}.png`));
	expect(await fullShiftFor(startIds.slice(0, 3), day)).toBe(3);
	expect(
		await count(
			`SELECT 1 FROM person_merge_log WHERE kept_person_id = ANY($1) AND merged_by_manager_id = $2
			   AND admin_id IS NULL`,
			[startIds, manager.id]
		)
	).toBe(3);
	expect(
		await count(`SELECT 1 FROM persons WHERE id = $1 AND status = 'active'`, [endIds[3]])
	).toBe(1);

	await page.reload();
	await expect(page.getByTestId('same-pair')).toHaveCount(1);

	// Another plant's manager cannot merge this pump's workers.
	const { plantId: otherPlant } = await createArea();
	const stranger = await login((await createPlantManager(otherPlant)).email);
	const response = await stranger.post(
		`/plant-manager/attendance/correct?/samePeople&pump=${pump.id}&day=${day}`,
		{
			form: { [`pair_${endIds[3]}`]: startIds[3] },
			headers: { accept: 'application/json', 'x-sveltekit-action': 'true' }
		}
	);
	expect((await response.json()).type).toBe('failure');
	expect(
		await count(`SELECT 1 FROM persons WHERE id = $1 AND status = 'active'`, [endIds[3]])
	).toBe(1);
});
