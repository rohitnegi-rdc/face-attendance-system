// Load-test fixture for the admin pump-detail attendance page (item 5 of the
// daily-aggregate/calendar/trend rework): seeds 200+ persons and a realistic mix of
// daily_person_attendance rows for one tagged test pump, covering the same 7-day window
// the page defaults to, including a genuine zero-attendance day and a duplicate-insert
// check. Run with: npx tsx scripts/seed-attendance-load-test.ts
// Cleanup only: npx tsx scripts/seed-attendance-load-test.ts --cleanup
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import pg from 'pg';

dayjs.extend(utc);
dayjs.extend(timezone);
const IST = 'Asia/Kolkata';

const { Pool } = pg;
const DATABASE_URL =
	process.env.DATABASE_URL || 'postgres://attendance:attendance@127.0.0.1:5433/attendance';
const pool = new Pool({ connectionString: DATABASE_URL });

const PERSON_COUNT = Number(process.env.LOADTEST_PERSON_COUNT ?? 220);
const TAG_PREFIX = 'LOADTEST';
const CLEANUP_ONLY = process.argv.includes('--cleanup');

function todayStr(): string {
	return dayjs().tz(IST).format('YYYY-MM-DD');
}
function addDaysStr(dateStr: string, days: number): string {
	return dayjs.tz(dateStr, IST).add(days, 'day').format('YYYY-MM-DD');
}
function daysBetween(from: string, to: string): string[] {
	const start = dayjs.tz(from, IST);
	const end = dayjs.tz(to, IST);
	const days: string[] = [];
	for (let d = start; d.isBefore(end) || d.isSame(end, 'day'); d = d.add(1, 'day')) {
		days.push(d.format('YYYY-MM-DD'));
	}
	return days;
}

function assert(condition: boolean, message: string) {
	if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function cleanup(pool: pg.Pool) {
	// Children before parents. pump_code/name are all tagged LOADTEST%, so this is scoped
	// and never touches real data — safe to run before AND after a seeding pass.
	await pool.query(
		`DELETE FROM daily_person_attendance WHERE pump_id IN (SELECT id FROM pumps WHERE pump_code LIKE $1)`,
		[`${TAG_PREFIX}%`]
	);
	await pool.query(
		`DELETE FROM persons WHERE pump_id IN (SELECT id FROM pumps WHERE pump_code LIKE $1)`,
		[`${TAG_PREFIX}%`]
	);
	await pool.query(`DELETE FROM pumps WHERE pump_code LIKE $1`, [`${TAG_PREFIX}%`]);
	await pool.query(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG_PREFIX}%`]);
	await pool.query(`DELETE FROM plants WHERE name LIKE $1`, [`${TAG_PREFIX}%`]);
	await pool.query(`DELETE FROM areas WHERE name LIKE $1`, [`${TAG_PREFIX}%`]);
}

async function main() {
	console.log(`Cleaning up any previous ${TAG_PREFIX} data...`);
	await cleanup(pool);
	if (CLEANUP_ONLY) {
		console.log('Cleanup complete, --cleanup was passed, exiting.');
		await pool.end();
		return;
	}

	const runTag = `${TAG_PREFIX}${Date.now()}`;
	console.log(`Seeding load-test data, tag: ${runTag}`);

	const area = await pool.query<{ id: string }>(
		`INSERT INTO areas (name) VALUES ($1) RETURNING id`,
		[runTag]
	);
	const plant = await pool.query<{ id: string }>(
		`INSERT INTO plants (area_id, name) VALUES ($1, $2) RETURNING id`,
		[area.rows[0].id, `${runTag}-plant`]
	);
	const vendor = await pool.query<{ id: string }>(
		`INSERT INTO vendors (name, email, password_hash) VALUES ($1, $2, 'unused') RETURNING id`,
		[runTag, `${runTag.toLowerCase()}@loadtest.local`]
	);
	const pump = await pool.query<{ id: string; pump_code: string }>(
		`INSERT INTO pumps (plant_id, vendor_id, pump_code, login_email, password_hash)
		 VALUES ($1, $2, $3, $4, 'unused') RETURNING id, pump_code`,
		[plant.rows[0].id, vendor.rows[0].id, runTag, `${runTag.toLowerCase()}@pumps.loadtest.local`]
	);
	const pumpId = pump.rows[0].id;
	console.log(`Pump: ${pump.rows[0].pump_code} (${pumpId})`);

	console.log(`Inserting ${PERSON_COUNT} persons...`);
	const personIds: string[] = [];
	for (let i = 1; i <= PERSON_COUNT; i += 1) {
		const { rows } = await pool.query<{ id: string }>(
			`INSERT INTO persons (pump_id, display_seq, status) VALUES ($1, $2, 'active') RETURNING id`,
			[pumpId, i]
		);
		personIds.push(rows[0].id);
	}

	// The page's calendar defaults to a fixed 7-day window ending "today" (IST). Mirror
	// that exactly so the load test exercises the real default, not an arbitrary range.
	const to = todayStr();
	const from = addDaysStr(to, -6);
	const window = daysBetween(from, to);
	assert(window.length === 7, `expected 7-day window, got ${window.length}`);

	// One day gets zero rows for anyone at all — the real shape of a "zero attendance" day
	// at the DB level (no rows for that session_date), not all-absent rows.
	const zeroAttendanceDay = window[2];
	const activeDays = window.filter((d) => d !== zeroAttendanceDay);

	console.log(`Window: ${from} .. ${to} (zero-attendance day: ${zeroAttendanceDay})`);
	console.log('Inserting daily_person_attendance rows...');

	// Deterministic, varied mix: person index mod 4 decides their pattern for every active day.
	// 0 = full present, 1 = morning-only, 2 = evening-only, 3 = absent (no row at all).
	let insertedRows = 0;
	const expected: Record<string, { present: number; morningOnly: number; eveningOnly: number }> =
		{};
	for (const day of window) expected[day] = { present: 0, morningOnly: 0, eveningOnly: 0 };

	for (const day of activeDays) {
		for (let i = 0; i < personIds.length; i += 1) {
			const pattern = i % 4;
			if (pattern === 3) continue; // absent — no row
			const morning = pattern === 0 || pattern === 1;
			const evening = pattern === 0 || pattern === 2;
			await pool.query(
				`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched, evening_matched)
				 VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (person_id, session_date) DO UPDATE SET
				   morning_matched = EXCLUDED.morning_matched, evening_matched = EXCLUDED.evening_matched`,
				[personIds[i], pumpId, day, morning, evening]
			);
			insertedRows += 1;
			if (morning && evening) expected[day].present += 1;
			else if (morning) expected[day].morningOnly += 1;
			else if (evening) expected[day].eveningOnly += 1;
		}
	}
	console.log(
		`Inserted ${insertedRows} daily_person_attendance rows across ${activeDays.length} days.`
	);

	// --- Duplicate-record check: the schema's real constraint is UNIQUE(person_id, session_date),
	// not (pump_id, person_id, session_date) — confirm the upsert merges, doesn't double-count.
	// Uses the same (person, day, present/present) values as the original insert for this
	// person (index 0 -> pattern 0 -> present), so no expected-count adjustment is needed —
	// this re-insert should be a true no-op from the aggregate's point of view.
	console.log('Checking duplicate-insert (ON CONFLICT) behavior...');
	const dupPersonId = personIds[0];
	const dupDay = activeDays[0];
	await pool.query(
		`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched, evening_matched)
		 VALUES ($1, $2, $3, true, true)
		 ON CONFLICT (person_id, session_date) DO UPDATE SET
		   morning_matched = EXCLUDED.morning_matched, evening_matched = EXCLUDED.evening_matched`,
		[dupPersonId, pumpId, dupDay]
	);
	const dupCheck = await pool.query(
		`SELECT count(*)::int AS n FROM daily_person_attendance WHERE person_id = $1 AND session_date = $2`,
		[dupPersonId, dupDay]
	);
	assert(
		dupCheck.rows[0].n === 1,
		`duplicate insert should merge to exactly 1 row, got ${dupCheck.rows[0].n}`
	);
	console.log('Duplicate-insert check passed: exactly 1 row survives.');

	// --- DB-side cross-check: independently recompute expected/morning/evening per day from
	// the DB itself and compare against the in-memory expectation built while inserting.
	console.log('Cross-checking DB-side aggregates against expected values...');
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
		 WHERE pump_id = $1 AND session_date >= $2 AND session_date <= $3
		 GROUP BY session_date`,
		[pumpId, from, to]
	);
	const dbByDay = new Map(dbTotals.rows.map((r) => [r.session_date, r]));
	for (const day of window) {
		const exp = expected[day];
		const actual = dbByDay.get(day);
		if (day === zeroAttendanceDay) {
			assert(!actual, `zero-attendance day ${day} should have no daily_person_attendance rows`);
			continue;
		}
		assert(!!actual, `expected a row for ${day}, found none`);
		assert(
			Number(actual!.present) === exp.present,
			`present mismatch on ${day}: expected ${exp.present}, got ${actual!.present}`
		);
		assert(
			Number(actual!.morning_only) === exp.morningOnly,
			`morning_only mismatch on ${day}: expected ${exp.morningOnly}, got ${actual!.morning_only}`
		);
		assert(
			Number(actual!.evening_only) === exp.eveningOnly,
			`evening_only mismatch on ${day}: expected ${exp.eveningOnly}, got ${actual!.evening_only}`
		);
	}
	console.log('DB cross-check passed: all 7 days match expected present/morning/evening counts.');

	console.log('\n--- Summary ---');
	console.log(`Pump ID: ${pumpId}`);
	console.log(`Pump code: ${pump.rows[0].pump_code}`);
	console.log(`Persons: ${personIds.length}`);
	console.log(`Window: ${from} .. ${to}`);
	console.log(`Zero-attendance day: ${zeroAttendanceDay}`);
	console.log(`\nVisit /admin/pumps/${pumpId} to inspect manually.`);
	console.log(`Run "npx tsx scripts/seed-attendance-load-test.ts --cleanup" to remove this data.`);

	await pool.end();
}

main().catch(async (err) => {
	console.error(err);
	await pool.end();
	process.exitCode = 1;
});
