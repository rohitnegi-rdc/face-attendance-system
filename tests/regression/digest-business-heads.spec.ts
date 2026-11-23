// SET-05: business heads, one per plant like business managers (2026-11-17: "add BH also in the
// daily mail from this mapping and create their view also for their plants just like BM , plant
// manager and other users", mapping BHBMPLANTSMAPPING.MD, imported by migration 052). An admin
// gives plants to a business head at /admin/business-heads; the head is copied on the 9 am email of
// those plants' Areas (worker test: tests/unit/attendanceDigest.test.ts) and sees those plants read
// only. The email shows each pump's missed day request with its reason and where it stands.
import { expect, test } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import {
	PASSWORD,
	action,
	createAdmin,
	createArea,
	createPlantManager,
	createPump,
	db,
	login
} from './helpers';
import { daysAgo, noSidewaysScroll, signIn } from './regularisationHelpers';
import { renderAttendanceDigest } from '../../worker/digestEmail.js';

const ORIGIN = process.env.REGRESSION_BASE_URL ?? 'http://127.0.0.1:6105';

async function businessHead(plantId: string, name: string) {
	const email = `bh${randomUUID().slice(0, 8)}@regression.test`;
	const { rows } = await db.query(
		`INSERT INTO plant_managers (name, email, password_hash, must_change_password, is_business_head)
		 VALUES ($1, $2, $3, FALSE, true) RETURNING id`,
		[name, email, await bcrypt.hash(PASSWORD, 4)]
	);
	await db.query('INSERT INTO business_head_plants (plant_id, manager_id) VALUES ($1, $2)', [
		plantId,
		rows[0].id
	]);
	return { id: rows[0].id as string, email };
}

const activeToday = (pumpId: string, adminId: string) =>
	db.query(
		`INSERT INTO pump_day_status (pump_id, day, status, set_by_role, set_by_id, set_by_name)
		 VALUES ($1, $2, 'active', 'admin', $3, 'Regression')`,
		[pumpId, daysAgo(0), adminId]
	);

test('SET-05 an admin gives a plant to a business head; settings lists them for its area', async ({
	page
}) => {
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(String(e)));
	page.on('console', (m) => {
		if (m.type() === 'error') problems.push(m.text());
	});
	const admin = await createAdmin();
	const { areaId, plantId } = await createArea();
	const { rows } = await db.query('SELECT name FROM areas WHERE id = $1', [areaId]);
	const areaName = rows[0].name as string;
	const email = `head${randomUUID().slice(0, 6)}@regression.test`;
	const name = `Head ${randomUUID().slice(0, 6)}`;

	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, admin.email);
	await page.goto('/admin/business-heads');
	await expect(page.getByRole('heading', { name: 'Business heads', level: 1 })).toBeVisible();
	const form = page.getByTestId('bh-assign');
	await form.locator('select[name="plant_id"]').selectOption(plantId);
	await form.locator('select[name="manager_id"]').selectOption('');
	await form.locator('input[name="name"]').fill(name);
	await form.locator('input[name="email"]').fill(email.toUpperCase());
	await form.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('status')).toContainText('has its business head.');

	// Stored as a business head login (lower case email) with the plant, and audited.
	const { rows: saved } = await db.query(
		`SELECT pm.id, pm.is_business_head, pm.is_business_manager FROM business_head_plants b
		 JOIN plant_managers pm ON pm.id = b.manager_id WHERE b.plant_id = $1 AND pm.email = $2`,
		[plantId, email]
	);
	expect(saved).toHaveLength(1);
	expect(saved[0]).toMatchObject({ is_business_head: true, is_business_manager: false });
	const { rows: audit } = await db.query(
		`SELECT target_type FROM admin_audit_log WHERE action = 'business_head_assign' AND target_id = $1`,
		[saved[0].id]
	);
	expect(audit).toEqual([{ target_type: 'business_head' }]);

	// Still there after a reload, on the Business heads list only.
	await page.reload();
	const row = page.getByTestId('bh-row').filter({ hasText: name });
	await expect(row).toContainText(email);
	await row.scrollIntoViewIfNeeded();
	await noSidewaysScroll(page);
	await page.screenshot({ path: 'artifacts/deep-build/screenshots/business-heads-mobile.png' });
	await page.goto('/admin/business-managers');
	await expect(page.getByTestId('bm-list')).not.toContainText(email);

	// Settings shows who gets the email for the area: the head in CC, from the plant, and the
	// plant's manager also in CC (2026-11-18: "add plant managers and business managers in cc not TO").
	const pm = await createPlantManager(plantId);
	const { rows: pmRow } = await db.query('SELECT name FROM plant_managers WHERE id = $1', [pm.id]);
	await page.goto('/admin/settings');
	await page.getByTestId('area-cc-search').fill(areaName);
	const card = page.locator(`[data-testid="digest-area"][data-area="${areaName}"]`);
	await card.scrollIntoViewIfNeeded();
	await expect(card.getByTestId('digest-area-heads')).toContainText(`${name} (${email})`);
	await expect(card.getByTestId('digest-area-managers')).toContainText('CC, business managers:');
	await expect(card.getByTestId('digest-area-managers')).toContainText('none');
	await expect(card.getByTestId('digest-area-plant-managers')).toContainText(
		`CC, plant managers: ${pmRow[0].name} (${pm.email})`
	);
	await expect(card).not.toContainText('To, ');
	await expect(page.getByTestId('bh-add')).toHaveCount(0);
	await noSidewaysScroll(page);
	await card.screenshot({ path: 'artifacts/deep-build/screenshots/digest-heads-mobile.png' });

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/admin/business-heads');
	await page.getByTestId('bh-row').filter({ hasText: name }).scrollIntoViewIfNeeded();
	await page.screenshot({ path: 'artifacts/deep-build/screenshots/business-heads-desktop.png' });

	// Remove: the login is closed and the plant has no head.
	const api = await login(admin.email);
	const removed = await action(api, '/admin/business-heads?/remove', { id: saved[0].id });
	expect(removed.type).toBe('success');
	const { rows: gone } = await db.query(
		'SELECT is_business_head, disabled_at FROM plant_managers WHERE id = $1',
		[saved[0].id]
	);
	expect(gone[0].is_business_head).toBe(false);
	expect(gone[0].disabled_at).not.toBeNull();
	expect(
		(await db.query('SELECT 1 FROM business_head_plants WHERE plant_id = $1', [plantId])).rowCount
	).toBe(0);
	expect(problems).toEqual([]);
});

test("SET-05 a business head sees only its plants' pumps and changes nothing", async ({ page }) => {
	const admin = await createAdmin();
	const mine = await createArea();
	const other = await createArea();
	const [myPump, otherPump] = await Promise.all([
		createPump(mine.plantId),
		createPump(other.plantId)
	]);
	await activeToday(myPump.id, admin.id);
	await activeToday(otherPump.id, admin.id);
	const head = await businessHead(mine.plantId, 'Japjit Singh');

	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, head.email);
	// The day checklist is not theirs: they land on Missed days, with the pages they may look at.
	await expect(page).toHaveURL(/\/plant-manager\/regularisations$/);
	await page.goto('/plant-manager');
	await expect(page).toHaveURL(/\/plant-manager\/regularisations$/);
	await page.goto('/plant-manager/pumps');
	await expect(page.getByText(myPump.code)).toBeVisible();
	await expect(page.getByText(otherPump.code)).toHaveCount(0);
	await noSidewaysScroll(page);
	await page.screenshot({
		path: 'artifacts/deep-build/screenshots/business-head-view-mobile.png',
		fullPage: true
	});

	// Read only: even the missed day decisions a business manager may post are refused.
	const api = await login(head.email);
	for (const path of ['/plant-manager/regularisations?/decide', '/plant-manager/pump-status']) {
		const response = await api.post(path, {
			form: { id: randomUUID(), decision: 'approve' },
			headers: { origin: ORIGIN },
			maxRedirects: 0
		});
		expect(response.status(), path).toBe(403);
	}
});

test('SET-05 only an admin can change business heads', async () => {
	const { plantId } = await createArea();
	const manager = await createPlantManager(plantId);
	const api = await login(manager.email);
	const response = await action(api, '/admin/business-heads?/assign', {
		plant_id: plantId,
		manager_id: '',
		name: 'Sneaky',
		email: 'sneaky@rdc.in'
	});
	expect(response.type).not.toBe('success');
	expect(
		(await db.query('SELECT 1 FROM business_head_plants WHERE plant_id = $1', [plantId])).rowCount
	).toBe(0);
});

test('SET-05 the email shows each missed day request with its reason, at phone width', async ({
	page
}) => {
	const zero = { full_shift: 0, start_only: 0, end_only: 0, workers: 0, mtd_workers: 0 };
	type Request = {
		status: string;
		reason: string;
		note: string | null;
		voice?: boolean;
		decider?: string;
		decider_role?: string;
		decided_by?: string;
		decision_reason?: string;
	};
	const pumpOf = (code: string, request: Request | null, worked = false) => ({
		pump_code: code,
		site_name: 'Lodha Palava',
		start_at: worked ? '2026-11-16T02:35:00Z' : null,
		end_at: null,
		...zero,
		...(worked ? { start_only: 3, workers: 3, mtd_workers: 30 } : {}),
		request
	});
	const pumps = [
		pumpOf('PUMPMU6', {
			status: 'pending',
			reason: 'phone_problem',
			note: 'Phone fell in water at the site',
			voice: true,
			decider: 'Asha Patil',
			decider_role: 'business manager'
		}),
		pumpOf('PUMPMU7', {
			status: 'rejected',
			reason: 'forgot',
			note: null,
			decided_by: 'Asha Patil',
			decision_reason: 'The workers listed are not right'
		}),
		pumpOf('PUMPMU8', null, true)
	];
	const { html } = renderAttendanceDigest({
		area: 'Mumbai',
		day: '2026-11-16',
		mtd: { pump_days: 48, marked: 40 },
		totals: { pumps: 3, marked: 1, ...zero, start_only: 3, workers: 3, mtd_workers: 30 },
		areas: [
			{
				name: 'Mumbai',
				plants: [
					{ id: 'p', name: 'MU-Thane', pumps, totals: { ...zero, start_only: 3, workers: 3 } }
				]
			}
		]
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.setContent(`<body style="font-family:Arial;margin:8px">${html}</body>`);
	const pending = page.locator('[data-request="pending"]');
	await expect(pending).toHaveText(
		'Missed day request: Phone dead or broken, “Phone fell in water at the site”, with a voice note in the app. Waiting for approval by Asha Patil (business manager).'
	);
	await expect(page.locator('[data-request="rejected"]')).toContainText(
		'Rejected by Asha Patil: The workers listed are not right.'
	);
	await page.screenshot({
		path: 'artifacts/deep-build/screenshots/digest-email-mobile.png',
		fullPage: true
	});
});
