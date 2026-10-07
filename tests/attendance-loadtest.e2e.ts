// Verifies the admin pump-detail page stays correct and responsive with 200+ roster
// records: exactly 7 calendar day-rows, daily-summary numbers matching an independent DB
// query, and the zero-attendance day rendering as 0/0/0 rather than blank/broken.
//
// Requires the fixture from scripts/seed-attendance-load-test.ts to already exist:
//   npm run test:pump-page:load:seed
//   npm run test:pump-page:load:e2e
import { expect, test } from '@playwright/test';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
	connectionString:
		process.env.DATABASE_URL || 'postgres://attendance:attendance@127.0.0.1:5433/attendance'
});
const baseUrl = process.env.ATTENDANCE_E2E_BASE_URL || 'http://localhost:3001';

test('pump detail page stays correct and responsive with 200+ roster records', async ({ page }) => {
	const pumpResult = await pool.query<{ id: string; pump_code: string }>(
		`SELECT id, pump_code FROM pumps WHERE pump_code LIKE 'LOADTEST%' ORDER BY created_at DESC LIMIT 1`
	);
	const pump = pumpResult.rows[0];
	if (!pump) {
		throw new Error(
			'No LOADTEST pump found. Run "npm run test:pump-page:load:seed" before this test.'
		);
	}

	const personCount = await pool.query<{ n: string }>(
		`SELECT count(*)::int AS n FROM persons WHERE pump_id = $1`,
		[pump.id]
	);
	expect(Number(personCount.rows[0].n)).toBeGreaterThanOrEqual(200);

	const admin = await pool.query<{ id: string; email: string }>(
		`SELECT id, email FROM admins ORDER BY created_at LIMIT 1`
	);
	if (!admin.rows[0]) throw new Error('No admin account available — run npm run seed first.');
	const token = jwt.sign(
		{ role: 'admin', id: admin.rows[0].id, email: admin.rows[0].email },
		process.env.JWT_SECRET || 'dev-secret-change-me',
		{ expiresIn: '1h' }
	);
	await page
		.context()
		.addCookies([{ name: 'session', value: token, url: baseUrl, httpOnly: true, sameSite: 'Lax' }]);

	// Independently recompute the expected per-day breakdown directly from the DB, mirroring
	// +page.server.ts's own query — this is the ground truth the rendered page is checked
	// against, not a copy of the app's in-memory logic.
	const dbTotals = await pool.query<{
		session_date: string;
		present: string;
		morning_only: string;
		evening_only: string;
	}>(
		`SELECT session_date::text,
		   COUNT(*) FILTER (WHERE morning_matched AND evening_matched) AS present,
		   COUNT(*) FILTER (WHERE morning_matched AND NOT evening_matched) AS morning_only,
		   COUNT(*) FILTER (WHERE evening_matched AND NOT morning_matched) AS evening_only
		 FROM daily_person_attendance
		 WHERE pump_id = $1
		 GROUP BY session_date
		 ORDER BY session_date`,
		[pump.id]
	);
	expect(dbTotals.rows.length).toBe(6); // 7-day window minus the one zero-attendance day

	const start = Date.now();
	await page.goto(`${baseUrl}/admin/pumps/${pump.id}`);
	await expect(page.locator('h1')).toHaveText(pump.pump_code);
	const elapsedMs = Date.now() - start;
	// Generous budget for 200+ roster columns on a cold dev build — this is a responsiveness
	// smoke check, not a strict perf gate.
	expect(elapsedMs).toBeLessThan(20_000);

	// Calendar renders exactly 7 day-rows (tbody rows), regardless of roster size.
	const calendarRows = page.locator('.calendar-frame table.calendar-grid tbody tr');
	await expect(calendarRows).toHaveCount(7);

	// Daily-summary table: exactly 7 rows, numbers matching the independent DB query above.
	const summaryRows = page.locator('.daily-summary-table tbody tr');
	await expect(summaryRows).toHaveCount(7);

	const dbByDate = new Map(dbTotals.rows.map((r) => [r.session_date, r]));
	const rowCount = await summaryRows.count();
	let zeroRowsSeen = 0;
	for (let i = 0; i < rowCount; i += 1) {
		const row = summaryRows.nth(i);
		const cells = row.locator('td');
		const presentText = await cells.nth(1).innerText();
		const morningText = await cells.nth(2).innerText();
		const eveningText = await cells.nth(3).innerText();

		if (presentText === '0' && morningText === '0' && eveningText === '0') {
			zeroRowsSeen += 1;
			continue;
		}
		const anyDbRow = [...dbByDate.values()].find(
			(r) =>
				r.present === presentText &&
				r.morning_only === morningText &&
				r.evening_only === eveningText
		);
		expect(
			anyDbRow,
			`row ${presentText}/${morningText}/${eveningText} should match a DB day`
		).toBeTruthy();
	}
	// Exactly one day (the seeded zero-attendance day) should render as 0/0/0.
	expect(zeroRowsSeen).toBe(1);
});
