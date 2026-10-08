// SUB, PAIR and settings scenarios from plans/RegressionTestPlan.md.
import { expect, test } from '@playwright/test';
import {
	action,
	clearSettings,
	createAdmin,
	createArea,
	createPump,
	db,
	login,
	photo,
	recordSession,
	setSettings,
	shiftBack,
	submit,
	waitForSession
} from './helpers';

test.afterEach(clearSettings);

async function newPump() {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	return { pump, context: await login(pump.email) };
}

test('SUB-01 first photo of the day is a queued morning that the worker processes', async () => {
	const { context } = await newPump();
	const submitted = await submit(context, await photo(['SUB01']));
	expect(submitted.status).toBe(202);
	const session = await waitForSession(submitted.body.session_id, ['review']);
	expect(session.session_type).toBe('morning');
	expect(session.pairing_status).toBe('open');
});

test('SUB-02 the same photo bytes are rejected the second time', async () => {
	const { context } = await newPump();
	const buffer = await photo(['SUB02']);
	expect((await submit(context, buffer)).status).toBe(202);
	const again = await submit(context, buffer);
	expect(again.status).toBe(409);
	expect(again.body.error).toContain('Duplicate photo');
});

test('SUB-03 wrong file type and empty file are rejected with no row', async () => {
	const { pump, context } = await newPump();
	expect((await submit(context, await photo(), 'application/pdf')).status).toBe(415);
	expect((await submit(context, Buffer.alloc(0))).status).toBe(413);
	const { rows } = await db.query('SELECT 1 FROM attendance_sessions WHERE pump_id = $1', [
		pump.id
	]);
	expect(rows).toHaveLength(0);
});

test('SUB-07 submitting while the morning is still processing explains why', async () => {
	const { context } = await newPump();
	const slow = await submit(context, await photo(['SUB07'], { delayMs: 4000 }));
	expect(slow.status).toBe(202);
	const second = await submit(context, await photo(['SUB07']));
	expect(second.status).toBe(409);
	expect(second.body.error).toContain('still being processed');
});

test('PAIR-01 evening is refused before the 9 hour production gap', async () => {
	const { context } = await newPump();
	const morningId = await recordSession(context, ['PAIR01']);
	const early = await submit(context, await photo(['PAIR01']));
	expect(early.status).toBe(409);
	expect(early.body.error).toMatch(/Evening attendance opens in [89] h/);
	expect(early.body.error).not.toContain('Test');

	const today = await (await context.get('/api/attendance/today')).json();
	expect(today.can_submit).toBe(false);
	const { rows } = await db.query('SELECT submitted_at FROM attendance_sessions WHERE id = $1', [
		morningId
	]);
	const gapMinutes =
		(new Date(today.next_allowed_at).getTime() - new Date(rows[0].submitted_at).getTime()) / 60000;
	expect(gapMinutes).toBe(540);
});

test('PAIR-02/03 evening after 9 h pairs both rows, then the day is complete', async () => {
	const { context } = await newPump();
	const morningId = await recordSession(context, ['PAIR02']);
	await shiftBack(morningId, 541);
	const eveningId = await recordSession(context, ['PAIR02']);

	const { rows } = await db.query(
		`SELECT id, session_type, pairing_status, paired_session_id, session_date
		 FROM attendance_sessions WHERE id = ANY($1::uuid[])`,
		[[morningId, eveningId]]
	);
	const morning = rows.find((row) => row.id === morningId);
	const evening = rows.find((row) => row.id === eveningId);
	expect(evening.session_type).toBe('evening');
	expect(morning.pairing_status).toBe('paired');
	expect(evening.pairing_status).toBe('paired');
	expect(morning.paired_session_id).toBe(eveningId);
	expect(evening.paired_session_id).toBe(morningId);
	expect(String(evening.session_date)).toBe(String(morning.session_date));

	const third = await submit(context, await photo(['PAIR02']));
	expect(third.status).toBe(409);
	expect(third.body.error).toContain('Day complete');
});

test('PAIR-07 a missed evening does not swallow the next morning (16 h window)', async () => {
	const { context } = await newPump();
	const yesterdayMorning = await recordSession(context, ['PAIR07']);
	await shiftBack(yesterdayMorning, 17 * 60, true);

	const next = await submit(context, await photo(['PAIR07']));
	expect(next.status).toBe(202);
	const { rows } = await db.query(
		'SELECT id, session_type, pairing_status FROM attendance_sessions WHERE id = ANY($1::uuid[])',
		[[yesterdayMorning, next.body.session_id]]
	);
	expect(rows.find((row) => row.id === next.body.session_id).session_type).toBe('morning');
	expect(rows.find((row) => row.id === yesterdayMorning).pairing_status).toBe('expired');

	const rollup = await db.query(
		`SELECT y.days_morning_only FROM person_attendance_yearly y
		 JOIN person_face_vectors v ON v.person_id = y.person_id
		 WHERE v.session_id = $1`,
		[yesterdayMorning]
	);
	expect(rollup.rows[0]?.days_morning_only).toBe(1);
});

test('SET-01 admin can widen the window; the same gap then pairs as evening', async () => {
	const admin = await login((await createAdmin()).email);
	expect((await setSettings(admin, 540, 24)).type).toBe('success');

	const { context } = await newPump();
	const morningId = await recordSession(context, ['SET01']);
	await shiftBack(morningId, 17 * 60, true);
	const next = await submit(context, await photo(['SET01']));
	expect(next.status).toBe(202);
	const session = await waitForSession(next.body.session_id, ['review']);
	expect(session.session_type).toBe('evening');
});

test('SET-02 admin can shorten the evening gap for testing, and it is audited', async () => {
	const adminAccount = await createAdmin();
	const admin = await login(adminAccount.email);
	expect((await setSettings(admin, 5, 16)).type).toBe('success');

	const { context } = await newPump();
	const morningId = await recordSession(context, ['SET02']);
	const early = await submit(context, await photo(['SET02']));
	expect(early.status).toBe(409);
	expect(early.body.error).toMatch(/opens in [45] min/);
	await shiftBack(morningId, 6);
	expect((await submit(context, await photo(['SET02']))).status).toBe(202);

	const audit = await db.query(
		`SELECT details FROM admin_audit_log WHERE admin_id = $1 AND action = 'update_settings'`,
		[adminAccount.id]
	);
	expect(audit.rows[0].details.after).toEqual({
		evening_min_gap_minutes: 5,
		evening_pairing_window_hours: 16
	});
});

test('SET-03 invalid settings are refused and nothing changes', async () => {
	const admin = await login((await createAdmin()).email);
	expect((await setSettings(admin, 600, 9)).type).toBe('failure');
	expect((await setSettings(admin, 0, 16)).type).toBe('failure');
	expect((await setSettings(admin, 540, 99)).type).toBe('failure');
	const { rows } = await db.query('SELECT 1 FROM app_settings');
	expect(rows).toHaveLength(0);
});

test('SET-04 reset restores the production defaults', async () => {
	const admin = await login((await createAdmin()).email);
	await setSettings(admin, 5, 10);
	expect((await action(admin, '/admin/settings?/reset', {})).type).toBe('success');
	const { rows } = await db.query('SELECT 1 FROM app_settings');
	expect(rows).toHaveLength(0);
});
