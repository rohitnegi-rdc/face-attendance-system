// SHIFT scenarios from plans/RegressionTestPlan.md: single-button shift start/end, the pump's
// End session button, and the admin fixes (End session, Split, Move to date).
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
	action,
	createAdmin,
	createArea,
	createPump,
	createVendor,
	db,
	login,
	photo,
	recordSession,
	shiftBack,
	submit,
	waitForSession,
	type Pump
} from './helpers';

async function newPump() {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	return { pump, context: await login(pump.email) };
}

async function adminContext() {
	const account = await createAdmin();
	return { account, admin: await login(account.email) };
}

async function today(context: APIRequestContext) {
	return (await context.get('/api/attendance/today')).json();
}

async function session(id: string) {
	const { rows } = await db.query(
		`SELECT id, session_type, session_date::text AS session_date, pairing_status,
		        paired_session_id, closed_by, status
		 FROM attendance_sessions WHERE id = $1`,
		[id]
	);
	return rows[0];
}

async function istDate(daysAgo = 0) {
	const { rows } = await db.query(
		`SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date - $1::int)::text AS d`,
		[daysAgo]
	);
	return rows[0].d as string;
}

// Yearly roll-up of the one worker first seen in a session.
async function yearly(sessionId: string) {
	const { rows } = await db.query(
		`SELECT y.days_present, y.days_morning_only, y.days_evening_only
		 FROM person_attendance_yearly y
		 WHERE y.person_id = (SELECT person_id FROM attendance_face_evidence WHERE session_id = $1 LIMIT 1)`,
		[sessionId]
	);
	return rows[0] ?? { days_present: 0, days_morning_only: 0, days_evening_only: 0 };
}

async function daily(pump: Pump) {
	const { rows } = await db.query(
		`SELECT session_date::text AS session_date, morning_matched, evening_matched
		 FROM daily_person_attendance WHERE pump_id = $1 ORDER BY session_date`,
		[pump.id]
	);
	return rows;
}

function fix(admin: APIRequestContext, pump: Pump, name: string, form: Record<string, string>) {
	return action(admin, `/admin/pumps/${pump.id}?/${name}`, form);
}

test('SHIFT-01 End session opens after the gap, closes as start only, next photo starts a new shift', async () => {
	const { context } = await newPump();
	const startId = await recordSession(context, ['SHIFT01']);

	let state = await today(context);
	expect(state.state).toBe('evening');
	expect(state.can_end_session).toBe(false);
	const early = await context.post('/api/attendance/end');
	expect(early.status()).toBe(409);
	expect((await early.json()).error).toMatch(/Shift end opens in [89] h/);

	// A late-evening start yesterday, 10 h ago: the end window is open.
	await shiftBack(startId, 600, true);
	state = await today(context);
	expect(state.can_end_session).toBe(true);
	expect(state.can_submit).toBe(true);

	const ended = await context.post('/api/attendance/end');
	expect(ended.status(), await ended.text()).toBe(200);
	const start = await session(startId);
	expect(start.pairing_status).toBe('expired');
	expect(start.closed_by).toBe('pump');
	expect(await yearly(startId)).toMatchObject({ days_morning_only: 1, days_present: 0 });

	state = await today(context);
	expect(state.state).toBe('morning');
	expect(state.can_end_session).toBe(false);
	const next = await submit(context, await photo(['SHIFT01']));
	expect(next.status).toBe(202);
	const nextSession = await waitForSession(next.body.session_id, ['review']);
	expect(nextSession.session_type).toBe('morning');
});

test('SHIFT-02 End session needs an open shift and a pump login', async () => {
	const { context } = await newPump();
	const none = await context.post('/api/attendance/end');
	expect(none.status()).toBe(409);
	expect((await none.json()).error).toContain('no open shift');

	const { admin } = await adminContext();
	expect((await admin.post('/api/attendance/end')).status()).toBe(403);
});

test('SHIFT-03 a late-evening start pairs with an end photo after midnight on the start date', async () => {
	const { context } = await newPump();
	const startId = await recordSession(context, ['SHIFT03']);
	await shiftBack(startId, 11 * 60, true);
	const endId = await recordSession(context, ['SHIFT03']);
	const end = await session(endId);
	expect(end.session_type).toBe('evening');
	expect(end.session_date).toBe(await istDate(1));
	expect(await yearly(startId)).toMatchObject({ days_present: 1 });
	expect((await today(context)).state).toBe('morning');
});

test('SHIFT-04 admin Split turns a mistaken end into the next shift start and fixes the counts', async () => {
	const { pump, context } = await newPump();
	const startId = await recordSession(context, ['SHIFT04']);
	// Forgot to end yesterday's shift; this morning's start photo (20 h later) became its end.
	await shiftBack(startId, 20 * 60, true);
	const endId = await recordSession(context, ['SHIFT04']);
	expect((await session(endId)).session_type).toBe('evening');
	expect(await yearly(startId)).toMatchObject({ days_present: 1, days_morning_only: 0 });

	const { account, admin } = await adminContext();
	const result = await fix(admin, pump, 'splitShift', { session_id: endId });
	expect(result.type, JSON.stringify(result)).toBe('success');

	const oldStart = await session(startId);
	const newStart = await session(endId);
	expect(oldStart).toMatchObject({
		pairing_status: 'expired',
		closed_by: 'admin',
		paired_session_id: null
	});
	expect(newStart).toMatchObject({
		session_type: 'morning',
		session_date: await istDate(0),
		pairing_status: 'open',
		paired_session_id: null
	});
	expect(await daily(pump)).toEqual([
		{ session_date: await istDate(1), morning_matched: true, evening_matched: false },
		{ session_date: await istDate(0), morning_matched: true, evening_matched: false }
	]);
	expect(await yearly(startId)).toMatchObject({ days_present: 0, days_morning_only: 1 });

	const state = await today(context);
	expect(state.state).toBe('evening');
	expect(state.open_morning_session_id).toBe(endId);

	const audit = await db.query(
		`SELECT details FROM admin_audit_log WHERE admin_id = $1 AND action = 'split_shift'`,
		[account.id]
	);
	expect(audit.rows[0].details).toMatchObject({ pump_id: pump.id, newStartId: endId });
});

test('SHIFT-05 Split is refused when the photo day already has a shift start', async () => {
	const { pump, context } = await newPump();
	const startId = await recordSession(context, ['SHIFT05']);
	await shiftBack(startId, 541);
	const endId = await recordSession(context, ['SHIFT05']);

	const { admin } = await adminContext();
	const result = await fix(admin, pump, 'splitShift', { session_id: endId });
	expect(result.type).toBe('failure');
	expect((await session(endId)).session_type).toBe('evening');
	expect((await session(startId)).pairing_status).toBe('paired');
	expect((await fix(admin, pump, 'splitShift', { session_id: startId })).type).toBe('failure');
});

test('SHIFT-06 admin Move to date moves the whole shift and its attendance', async () => {
	const { pump, context } = await newPump();
	const startId = await recordSession(context, ['SHIFT06']);
	await shiftBack(startId, 541);
	const endId = await recordSession(context, ['SHIFT06']);
	expect((await today(context)).state).toBe('locked');

	const target = await istDate(3);
	const { account, admin } = await adminContext();
	const moved = await fix(admin, pump, 'moveShift', { session_id: endId, new_date: target });
	expect(moved.type, JSON.stringify(moved)).toBe('success');

	expect((await session(startId)).session_date).toBe(target);
	expect((await session(endId)).session_date).toBe(target);
	expect(await daily(pump)).toEqual([
		{ session_date: target, morning_matched: true, evening_matched: true }
	]);
	const finalized = await db.query(
		'SELECT session_date::text AS d FROM attendance_rollup_finalizations WHERE pump_id = $1',
		[pump.id]
	);
	expect(finalized.rows).toEqual([{ d: target }]);
	expect(await yearly(startId)).toMatchObject({ days_present: 1 });
	expect((await today(context)).state).toBe('morning');

	// Into an occupied date, into the future, or a bad date: refused, nothing moves.
	const other = await recordSession(context, ['SHIFT06']);
	expect((await fix(admin, pump, 'moveShift', { session_id: other, new_date: target })).type).toBe(
		'failure'
	);
	expect(
		(await fix(admin, pump, 'moveShift', { session_id: other, new_date: '2999-01-01' })).type
	).toBe('failure');
	expect(
		(await fix(admin, pump, 'moveShift', { session_id: other, new_date: 'yesterday' })).type
	).toBe('failure');
	expect((await session(other)).session_date).toBe(await istDate(0));

	const audit = await db.query(
		`SELECT count(*)::int AS n FROM admin_audit_log WHERE admin_id = $1 AND action = 'move_shift'`,
		[account.id]
	);
	expect(audit.rows[0].n).toBe(1);
});

test('SHIFT-07 admin End session closes an open start at once; not allowed on other rows', async () => {
	const { pump, context } = await newPump();
	const startId = await recordSession(context, ['SHIFT07']);
	const { account, admin } = await adminContext();

	const ended = await fix(admin, pump, 'endShift', { session_id: startId });
	expect(ended.type, JSON.stringify(ended)).toBe('success');
	expect(await session(startId)).toMatchObject({ pairing_status: 'expired', closed_by: 'admin' });
	expect(await yearly(startId)).toMatchObject({ days_morning_only: 1 });
	expect((await today(context)).state).toBe('locked');
	expect((await fix(admin, pump, 'endShift', { session_id: startId })).type).toBe('failure');

	// Another pump's session id through this pump's page is refused.
	const otherPump = await newPump();
	const foreign = await recordSession(otherPump.context, ['SHIFT07B']);
	expect((await fix(admin, pump, 'endShift', { session_id: foreign })).type).toBe('failure');
	expect((await session(foreign)).pairing_status).toBe('open');

	const audit = await db.query(
		`SELECT count(*)::int AS n FROM admin_audit_log WHERE admin_id = $1 AND action = 'end_shift'`,
		[account.id]
	);
	expect(audit.rows[0].n).toBe(1);
});

test('SHIFT-08 a start with no end after 24 h auto-closes with closed_by timeout', async () => {
	const { context } = await newPump();
	const startId = await recordSession(context, ['SHIFT08']);
	await shiftBack(startId, 25 * 60, true);
	// The lazy check on the pump screen runs the same rule as the hourly worker sweep.
	expect((await today(context)).state).toBe('morning');
	expect(await session(startId)).toMatchObject({ pairing_status: 'expired', closed_by: 'timeout' });
	expect(await yearly(startId)).toMatchObject({ days_morning_only: 1 });
});

test('SHIFT-09 a closed shift reports full or start only to the pump screen', async () => {
	const full = await newPump();
	const startId = await recordSession(full.context, ['SHIFT09']);
	await shiftBack(startId, 541);
	await recordSession(full.context, ['SHIFT09']);
	expect(await today(full.context)).toMatchObject({ state: 'locked', shift_outcome: 'full' });

	const { pump, context } = await newPump();
	const openStart = await recordSession(context, ['SHIFT09B']);
	expect((await today(context)).shift_outcome).toBeNull();
	const { admin } = await adminContext();
	expect((await fix(admin, pump, 'endShift', { session_id: openStart })).type).toBe('success');
	expect(await today(context)).toMatchObject({
		state: 'locked',
		shift_outcome: 'start_only',
		shift_closed_by: 'admin'
	});
});

test('SHIFT-10 an open shift is not counted as start only until it closes', async () => {
	const { plantId } = await createArea();
	const vendorAccount = await createVendor();
	const pump = await createPump(plantId, vendorAccount.id);
	const context = await login(pump.email);
	const vendor = await login(vendorAccount.email);
	// Full shift, Start only, End only columns of the single worker's row.
	const counts = async () => {
		const html = (await (await vendor.get('/vendor/people')).text()).replace(/<!--.*?-->/g, '');
		const row = html.match(/<td>\s*(\d+)\s*<\/td><td>\s*(\d+)\s*<\/td><td\s*>\s*(\d+)\s*<\/td>/);
		expect(row, 'worker row on /vendor/people').not.toBeNull();
		return row!.slice(1, 4).map(Number);
	};

	const startId = await recordSession(context, ['SHIFT10']);
	expect(await counts()).toEqual([0, 0, 0]);

	const { admin } = await adminContext();
	expect((await fix(admin, pump, 'endShift', { session_id: startId })).type).toBe('success');
	expect(await counts()).toEqual([0, 1, 0]);
});
