// REG-19: a missed day request the business manager has not decided in 2 days (escalation) is on
// the admin Overview with its evidence, how long it waited and whose decision it was, and an admin
// approves or rejects it there. A newer request is not. (The 48-hour email reaches only admins
// with a real mailbox; on production none have one, 2026-11-16.)
import { expect, test } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { PASSWORD, createAdmin, db } from './helpers';
import { crewPump, daysAgo, noSidewaysScroll, signIn } from './regularisationHelpers';

async function request(pumpId: string, day: string, hoursAgo: number, workers: string[]) {
	const { rows } = await db.query(
		`INSERT INTO regularisations (pump_id, day, reason, note, requested_by_role, requested_by_id,
		                              requested_by_name, requested_at, link_base)
		 VALUES ($1, $2, 'phone_problem', 'Phone fell in water', 'pump', $1, 'Pump',
		         now() - $3 * interval '1 hour', 'http://localhost')
		 RETURNING id`,
		[pumpId, day, hoursAgo]
	);
	for (const person of workers) {
		await db.query(
			'INSERT INTO regularisation_workers (regularisation_id, person_id) VALUES ($1, $2)',
			[rows[0].id, person]
		);
	}
	return rows[0].id as string;
}

const statusOf = async (id: string) =>
	(await db.query('SELECT status, decided_by_role FROM regularisations WHERE id = $1', [id]))
		.rows[0];

test('REG-19 requests waiting over 2 days are decided on the admin Overview', async ({ page }) => {
	const admin = await createAdmin();
	const { pump, plantId, workers } = await crewPump();
	const bmEmail = `bm${randomUUID().slice(0, 8)}@regression.test`;
	const { rows: bm } = await db.query(
		`INSERT INTO plant_managers (name, email, password_hash, must_change_password, is_business_manager)
		 VALUES ('Late Manager', $1, $2, FALSE, true) RETURNING id`,
		[bmEmail, await bcrypt.hash(PASSWORD, 4)]
	);
	await db.query('INSERT INTO business_manager_plants (plant_id, manager_id) VALUES ($1, $2)', [
		plantId,
		bm[0].id
	]);
	const toApprove = await request(pump.id, daysAgo(5), 74, workers.slice(0, 2));
	const toReject = await request(pump.id, daysAgo(6), 50, workers.slice(0, 1));
	const fresh = await request(pump.id, daysAgo(7), 3, workers.slice(0, 1));

	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, admin.email);
	await page.goto('/admin');
	const section = page.getByTestId('overdue-regularisations');
	const cards = section.locator(`[data-testid="reg-decide"][data-pump="${pump.code}"]`);
	await expect(cards).toHaveCount(2);
	// Oldest first, with how long it waited and who did not decide; the reason and workers inline.
	await expect(cards.first().getByTestId('reg-waiting')).toContainText('Waiting 3 days');
	await expect(cards.first().getByTestId('reg-waiting')).toContainText(
		'Late Manager (business manager) has not decided'
	);
	await expect(cards.first()).toContainText('Phone fell in water');
	await expect(cards.first()).toContainText('2 workers');
	await expect(cards.nth(1).getByTestId('reg-waiting')).toContainText('Waiting 2 days');
	await noSidewaysScroll(page);
	await page.screenshot({ path: 'artifacts/escalation/overview-mobile.png', fullPage: true });
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.screenshot({ path: 'artifacts/escalation/overview-desktop.png' });
	await page.setViewportSize({ width: 390, height: 844 });

	// Approve the oldest here.
	await cards.first().getByTestId('reg-approve').click();
	await expect(cards).toHaveCount(1);
	expect(await statusOf(toApprove)).toEqual({ status: 'approved', decided_by_role: 'admin' });

	// Reject the other with a reason.
	await cards.first().getByTestId('reg-reject-open').click();
	await cards.first().getByTestId('reg-reject-reason').selectOption('wrong_crew');
	await cards.first().getByTestId('reg-reject').click();
	await expect(cards).toHaveCount(0);
	expect(await statusOf(toReject)).toEqual({ status: 'rejected', decided_by_role: 'admin' });

	// The 3-hour-old one is still the business manager's, not on the Overview.
	expect((await statusOf(fresh)).status).toBe('pending');
});
