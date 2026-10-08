// MATCH, FRD, REV and admin delete/reset scenarios from plans/RegressionTestPlan.md.
import { expect, test } from '@playwright/test';
import {
	action,
	count,
	createAdmin,
	createArea,
	createPump,
	db,
	login,
	photo,
	recordSession,
	shiftBack,
	submit,
	waitForSession
} from './helpers';

async function sameAreaPumps(n: number) {
	const { plantId } = await createArea();
	const pumps = [];
	for (let i = 0; i < n; i++) {
		const pump = await createPump(plantId);
		pumps.push({ ...pump, context: await login(pump.email) });
	}
	return pumps;
}

async function submitAndWait(context: Parameters<typeof submit>[0], faces: string[]) {
	const submitted = await submit(context, await photo(faces));
	expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
	await waitForSession(submitted.body.session_id, ['review']);
	return submitted.body.session_id as string;
}

const fraudFlagsOn = (sessionId: string) =>
	count('SELECT 1 FROM fraud_flags WHERE session_id = $1', [sessionId]);

test('MATCH-01/04 new face becomes a worker; same face in the evening is the same person, no fraud', async () => {
	const [pump] = await sameAreaPumps(1);
	const morningId = await recordSession(pump.context, ['MATCH04']);
	expect(
		await count(`SELECT 1 FROM persons WHERE pump_id = $1 AND status = 'active'`, [pump.id])
	).toBe(1);
	await shiftBack(morningId, 541);
	const eveningId = await recordSession(pump.context, [{ identity: 'MATCH04', similarity: 0.9 }]);

	expect(await count('SELECT 1 FROM persons WHERE pump_id = $1', [pump.id])).toBe(1);
	expect(await fraudFlagsOn(eveningId)).toBe(0);
	const { rows } = await db.query(
		'SELECT morning_matched, evening_matched FROM daily_person_attendance WHERE pump_id = $1',
		[pump.id]
	);
	expect(rows).toEqual([{ morning_matched: true, evening_matched: true }]);
});

test('MATCH-03 a face below the threshold becomes a new person', async () => {
	const [pump] = await sameAreaPumps(1);
	const morningId = await recordSession(pump.context, ['MATCH03']);
	await shiftBack(morningId, 541);
	await recordSession(pump.context, [{ identity: 'MATCH03', similarity: 0.1 }]);
	expect(await count('SELECT 1 FROM persons WHERE pump_id = $1', [pump.id])).toBe(2);
});

test('MATCH-05 five workers in one photo give five attendance rows', async () => {
	const [pump] = await sameAreaPumps(1);
	await recordSession(
		pump.context,
		['G1', 'G2', 'G3', 'G4', 'G5'].map((g) => `MATCH05${g}`)
	);
	expect(await count('SELECT 1 FROM daily_person_attendance WHERE pump_id = $1', [pump.id])).toBe(
		5
	);
});

test('FRD-01 an approved worker at pump A is flagged at pump B in the same Area', async () => {
	const [a, b] = await sameAreaPumps(2);
	await recordSession(a.context, ['FRD01']);
	const sessionB = await submitAndWait(b.context, ['FRD01']);
	expect(await fraudFlagsOn(sessionB)).toBe(1);
	expect(await count('SELECT 1 FROM daily_person_attendance WHERE pump_id = $1', [b.id])).toBe(0);
});

test('FRD-02 the same face in a different Area is not fraud', async () => {
	const [a] = await sameAreaPumps(1);
	const [c] = await sameAreaPumps(1);
	await recordSession(a.context, ['FRD02']);
	const sessionC = await submitAndWait(c.context, ['FRD02']);
	expect(await fraudFlagsOn(sessionC)).toBe(0);
});

test('FRD-03/05/06 a brand-new worker still in pump review is flagged, in either order', async () => {
	for (const order of ['AthenB', 'BthenA']) {
		const [first, second] = await sameAreaPumps(2);
		const identity = `FRD05${order}`;
		// The first pump has NOT approved yet: its person is pending_review, its session in review.
		await submitAndWait(first.context, [identity]);
		const secondSession = await submitAndWait(second.context, [identity]);
		expect(await fraudFlagsOn(secondSession), order).toBe(1);
	}
});

test('FRD-07 a pump cannot erase fraud evidence by retrying', async () => {
	const [a, b] = await sameAreaPumps(2);
	const sessionA = await submitAndWait(a.context, ['FRD07']);
	const sessionB = await submitAndWait(b.context, ['FRD07']);
	expect(await fraudFlagsOn(sessionB)).toBe(1);

	expect((await b.context.post(`/api/attendance/retry/${sessionB}`)).status()).toBe(409);
	// Pump A's session is the evidence B's flag points at, so A cannot retry it either.
	expect((await a.context.post(`/api/attendance/retry/${sessionA}`)).status()).toBe(409);

	expect(await fraudFlagsOn(sessionB)).toBe(1);
	expect(
		await count('SELECT 1 FROM attendance_sessions WHERE id = ANY($1::uuid[])', [
			[sessionA, sessionB]
		])
	).toBe(2);
});

test('REV-02 approving twice is refused', async () => {
	const [pump] = await sameAreaPumps(1);
	const sessionId = await recordSession(pump.context, ['REV02']);
	expect((await pump.context.post(`/api/attendance/approve/${sessionId}`)).status()).toBe(409);
});

test('REV-03 a failed session can be retried and a new photo accepted', async () => {
	const [pump] = await sameAreaPumps(1);
	const submitted = await submit(pump.context, await photo(['REV03'], { fail: true }));
	expect(submitted.status).toBe(202);
	await waitForSession(submitted.body.session_id, ['failed'], 30_000);
	const retry = await pump.context.post(`/api/attendance/retry/${submitted.body.session_id}`);
	expect(retry.status()).toBe(200);
	expect(
		await count('SELECT 1 FROM attendance_sessions WHERE id = $1', [submitted.body.session_id])
	).toBe(0);
	expect((await submit(pump.context, await photo(['REV03']))).status).toBe(202);
});

test('REV-06 a completed session cannot be retried by the pump', async () => {
	const [pump] = await sameAreaPumps(1);
	const sessionId = await recordSession(pump.context, ['REV06']);
	expect((await pump.context.post(`/api/attendance/retry/${sessionId}`)).status()).toBe(409);
	expect(await count('SELECT 1 FROM attendance_sessions WHERE id = $1', [sessionId])).toBe(1);
});

test('ADM-11 admin delete/reset removes a flagged session, is audited, and the pump can submit again', async () => {
	const adminAccount = await createAdmin();
	const admin = await login(adminAccount.email);
	const [a, b] = await sameAreaPumps(2);
	await recordSession(a.context, ['ADM11']);
	const sessionB = await submitAndWait(b.context, ['ADM11']);
	expect(await fraudFlagsOn(sessionB)).toBe(1);

	const response = await action(admin, `/admin/pumps/${b.id}?/deleteSession`, {
		session_id: sessionB
	});
	expect(response.type).toBe('success');
	expect(await count('SELECT 1 FROM attendance_sessions WHERE id = $1', [sessionB])).toBe(0);
	expect(await fraudFlagsOn(sessionB)).toBe(0);
	const audit = await db.query(
		`SELECT details FROM admin_audit_log WHERE admin_id = $1 AND action = 'delete_session'`,
		[adminAccount.id]
	);
	expect(audit.rows[0].details.fraud_flags_deleted).toBe(1);
	expect((await submit(b.context, await photo(['ADM11new']))).status).toBe(202);
});

test('ADM-12 deleting a morning also deletes its evening and reverses the yearly rollup', async () => {
	const admin = await login((await createAdmin()).email);
	const [pump] = await sameAreaPumps(1);
	const morningId = await recordSession(pump.context, ['ADM12']);
	await shiftBack(morningId, 541);
	await recordSession(pump.context, ['ADM12']);
	const before = await db.query(
		`SELECT y.days_present FROM person_attendance_yearly y JOIN persons p ON p.id = y.person_id
		 WHERE p.pump_id = $1`,
		[pump.id]
	);
	expect(before.rows[0].days_present).toBe(1);

	const response = await action(admin, `/admin/pumps/${pump.id}?/deleteSession`, {
		session_id: morningId
	});
	expect(response.type).toBe('success');
	expect(await count('SELECT 1 FROM attendance_sessions WHERE pump_id = $1', [pump.id])).toBe(0);
	expect(await count('SELECT 1 FROM daily_person_attendance WHERE pump_id = $1', [pump.id])).toBe(
		0
	);
	const after = await db.query(
		`SELECT y.days_present FROM person_attendance_yearly y JOIN persons p ON p.id = y.person_id
		 WHERE p.pump_id = $1`,
		[pump.id]
	);
	expect(after.rows[0]?.days_present ?? 0).toBe(0);
});

test('ADM-13 clearing a pump needs the exact pump code, then removes all its data', async () => {
	const admin = await login((await createAdmin()).email);
	const [pump, other] = await sameAreaPumps(2);
	await recordSession(pump.context, ['ADM13A', 'ADM13B']);
	await submitAndWait(other.context, ['ADM13A']); // a fraud flag pointing at the cleared pump

	const wrong = await action(admin, `/admin/pumps/${pump.id}?/clearPumpData`, {
		confirm_code: 'WRONG'
	});
	expect(wrong.type).toBe('failure');
	expect(await count('SELECT 1 FROM attendance_sessions WHERE pump_id = $1', [pump.id])).toBe(1);

	const right = await action(admin, `/admin/pumps/${pump.id}?/clearPumpData`, {
		confirm_code: pump.code
	});
	expect(right.type).toBe('success');
	expect(await count('SELECT 1 FROM attendance_sessions WHERE pump_id = $1', [pump.id])).toBe(0);
	expect(await count('SELECT 1 FROM persons WHERE pump_id = $1', [pump.id])).toBe(0);
	expect(await count('SELECT 1 FROM fraud_flags WHERE matched_at_pump_id = $1', [pump.id])).toBe(0);
	expect(
		await count(
			`SELECT 1 FROM admin_audit_log WHERE action = 'clear_pump_attendance' AND target_id = $1`,
			[pump.id]
		)
	).toBe(1);
	// The pump account stays and can start fresh.
	expect((await submit(pump.context, await photo(['ADM13C']))).status).toBe(202);
});
