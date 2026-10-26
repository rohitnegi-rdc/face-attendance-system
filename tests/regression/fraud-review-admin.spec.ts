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

async function submitAndWait(
	context: Parameters<typeof submit>[0],
	faces: Parameters<typeof photo>[0]
) {
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

test('MATCH-09 a worker first seen at an uncompleted shift end is the same person next day', async () => {
	const [pump] = await sameAreaPumps(1);
	const startId = await recordSession(pump.context, ['MATCH09op']);
	await shiftBack(startId, 541);
	// A shift end must wait for a completed start, but the next day's start does not wait for a
	// completed end: this end stays in review, so its new worker is still pending_review.
	const endId = await submitAndWait(pump.context, ['MATCH09op', 'MATCH09']);
	await shiftBack(startId, 24 * 60, true);
	await shiftBack(endId, 24 * 60, true);
	await submitAndWait(pump.context, [{ identity: 'MATCH09', similarity: 0.9 }]);

	expect(await count('SELECT 1 FROM persons WHERE pump_id = $1', [pump.id])).toBe(2);
});

test('MATCH-10 a weak match counts attendance but does not join the gallery', async () => {
	const [pump] = await sameAreaPumps(1);
	const morningId = await recordSession(pump.context, ['MATCH10']);
	await shiftBack(morningId, 541);
	await recordSession(pump.context, [{ identity: 'MATCH10', similarity: 0.3 }]);

	expect(await count('SELECT 1 FROM persons WHERE pump_id = $1', [pump.id])).toBe(1);
	const { rows } = await db.query(
		`SELECT s.session_type, v.in_gallery, v.is_anchor
		 FROM person_face_vectors v JOIN attendance_sessions s ON s.id = v.session_id
		 WHERE s.pump_id = $1 ORDER BY v.created_at`,
		[pump.id]
	);
	expect(rows).toEqual([
		{ session_type: 'morning', in_gallery: true, is_anchor: true },
		{ session_type: 'evening', in_gallery: false, is_anchor: false }
	]);
	const attendance = await db.query(
		'SELECT morning_matched, evening_matched FROM daily_person_attendance WHERE pump_id = $1',
		[pump.id]
	);
	expect(attendance.rows).toEqual([{ morning_matched: true, evening_matched: true }]);
});

test('MATCH-11 two faces near the same worker are two people; the stronger keeps the worker', async () => {
	const [pump] = await sameAreaPumps(1);
	const morningId = await recordSession(pump.context, ['MATCH11']);
	await shiftBack(morningId, 541);
	// The weaker face comes first from the AI, so order alone would give it the worker.
	const eveningId = await recordSession(pump.context, [
		{ identity: 'MATCH11', similarity: 0.5 },
		{ identity: 'MATCH11', similarity: 0.9 }
	]);

	expect(await count('SELECT 1 FROM persons WHERE pump_id = $1', [pump.id])).toBe(2);
	const { rows } = await db.query(
		`SELECT p.first_seen_at < s.submitted_at AS known, round(e.match_confidence::numeric, 2)::float AS score
		 FROM attendance_face_evidence e
		 JOIN persons p ON p.id = e.person_id
		 JOIN attendance_sessions s ON s.id = e.session_id
		 WHERE e.session_id = $1 ORDER BY known DESC`,
		[eveningId]
	);
	expect(rows).toEqual([
		{ known: true, score: 0.9 },
		{ known: false, score: null }
	]);
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

test('FRD-14 the fraud check compares only faces from the other pump today, not older ones', async () => {
	const [a, b] = await sameAreaPumps(2);
	// Yesterday at B: the worker's sharp face. Past the pairing window, so today's photo is a start.
	const yesterday = await recordSession(b.context, ['FRD14']);
	await shiftBack(yesterday, 25 * 60, true);
	// Today at B: a worse photo of the same worker, still matched to them (0.4 >= threshold).
	await recordSession(b.context, [{ identity: 'FRD14', similarity: 0.4 }]);
	expect(await count('SELECT 1 FROM persons WHERE pump_id = $1', [b.id])).toBe(1);
	// At A, a face close to yesterday's photo (0.3) but not to today's (about 0.12).
	const sessionA = await submitAndWait(a.context, [{ identity: 'FRD14', similarity: 0.3 }]);
	expect(await fraudFlagsOn(sessionA)).toBe(0);
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

test('ADM-13 Clear test records deletes only test-mode shifts and keeps every genuine one', async () => {
	const admin = await login((await createAdmin()).email);
	const [pump, mixed] = await sameAreaPumps(2);
	const setTestMode = (on: boolean) =>
		on
			? db.query(
					`INSERT INTO app_settings (key, value) VALUES ('test_mode', 'true')
					 ON CONFLICT (key) DO UPDATE SET value = 'true'`
				)
			: db.query(`DELETE FROM app_settings WHERE key = 'test_mode'`);

	try {
		// Yesterday: a genuine shift start. Today: a test shift with that worker and a tester.
		const genuineId = await recordSession(pump.context, ['ADM13G']);
		await shiftBack(genuineId, 1500, true);
		// A part-test, part-genuine shift on the other pump: test start, genuine end.
		await setTestMode(true);
		const testId = await recordSession(pump.context, ['ADM13G', 'ADM13T']);
		const mixedStart = await recordSession(mixed.context, ['ADM13M']);
		await setTestMode(false);
		await shiftBack(mixedStart, 541);
		await recordSession(mixed.context, ['ADM13M']);
		expect(
			await count('SELECT 1 FROM attendance_sessions WHERE id = ANY($1) AND test_mode', [
				[genuineId, testId]
			])
		).toBe(1);
		const page = await (await admin.get(`/admin/pumps/${pump.id}`)).text();
		expect(page).toContain('data-testid="test-mode-session"');
		expect(page).toMatch(
			/data-testid="test-session-count"[^>]*>(<!--[^>]*-->)?<strong>1<\/strong> photo taken in test mode/
		);

		const wrong = await action(admin, `/admin/pumps/${pump.id}?/clearPumpData`, {
			confirm_code: 'WRONG'
		});
		expect(wrong.type).toBe('failure');
		expect(await count('SELECT 1 FROM attendance_sessions WHERE pump_id = $1', [pump.id])).toBe(2);

		const right = await action(admin, `/admin/pumps/${pump.id}?/clearPumpData`, {
			confirm_code: pump.code
		});
		expect(right.type).toBe('success');
		// The test shift and the tester seen only in it are gone; the genuine shift and worker stay.
		expect(await count('SELECT 1 FROM attendance_sessions WHERE id = $1', [testId])).toBe(0);
		expect(await count('SELECT 1 FROM attendance_sessions WHERE id = $1', [genuineId])).toBe(1);
		expect(await count('SELECT 1 FROM persons WHERE pump_id = $1', [pump.id])).toBe(1);
		expect(
			await count(
				`SELECT 1 FROM daily_person_attendance d JOIN attendance_sessions s
				   ON s.pump_id = d.pump_id AND s.session_date = d.session_date
				 WHERE s.id = $1 AND d.morning_matched`,
				[genuineId]
			)
		).toBe(1);
		expect(
			await count(
				`SELECT 1 FROM admin_audit_log WHERE action = 'clear_test_attendance' AND target_id = $1`,
				[pump.id]
			)
		).toBe(1);

		// Nothing left to clear: refused, nothing deleted.
		const again = await action(admin, `/admin/pumps/${pump.id}?/clearPumpData`, {
			confirm_code: pump.code
		});
		expect(again.type).toBe('failure');
		expect(await count('SELECT 1 FROM attendance_sessions WHERE pump_id = $1', [pump.id])).toBe(1);

		// A shift with a genuine end is kept whole, and the admin is told so.
		const kept = await action(admin, `/admin/pumps/${mixed.id}?/clearPumpData`, {
			confirm_code: mixed.code
		});
		expect(kept.type).toBe('success');
		const keptAudit = await db.query(
			`SELECT details FROM admin_audit_log WHERE action = 'clear_test_attendance' AND target_id = $1`,
			[mixed.id]
		);
		expect(keptAudit.rows[0].details.mixed_shifts_kept).toBe(1);
		expect(await count('SELECT 1 FROM attendance_sessions WHERE pump_id = $1', [mixed.id])).toBe(2);

		// The pump account stays and can submit again.
		expect((await submit(pump.context, await photo(['ADM13C']))).status).toBe(202);
	} finally {
		await setTestMode(false);
	}
});

test('MATCH-06 the default threshold is 0.28 when FACE_MATCH_THRESHOLD is empty', async () => {
	// The regression runner starts the worker with FACE_MATCH_THRESHOLD='' on purpose.
	for (const [similarity, expectedPeople] of [
		[0.29, 1],
		[0.27, 2]
	] as const) {
		const [pump] = await sameAreaPumps(1);
		const morningId = await recordSession(pump.context, [`MATCH06${similarity * 100}`]);
		await shiftBack(morningId, 541);
		await recordSession(pump.context, [{ identity: `MATCH06${similarity * 100}`, similarity }]);
		expect(
			await count('SELECT 1 FROM persons WHERE pump_id = $1', [pump.id]),
			`similarity ${similarity}`
		).toBe(expectedPeople);
	}
});

async function flaggedAtB(identity: string) {
	const [a, b] = await sameAreaPumps(2);
	await recordSession(a.context, [identity]);
	const sessionB = await submitAndWait(b.context, [identity]);
	const { rows } = await db.query('SELECT id FROM fraud_flags WHERE session_id = $1', [sessionB]);
	expect(rows).toHaveLength(1);
	return { a, b, sessionB, flagId: rows[0].id as string };
}

test('FRD-08 admin "not fraud" marks the worker present at the flagged pump as a new worker', async () => {
	const adminAccount = await createAdmin();
	const admin = await login(adminAccount.email);
	const { b, sessionB, flagId } = await flaggedAtB('FRD08new');

	const result = await action(admin, '/admin/fraud-flags?/notFraud', { id: flagId });
	expect(result.type).toBe('success');
	const { rows: people } = await db.query(
		`SELECT p.id, p.status FROM persons p WHERE p.pump_id = $1`,
		[b.id]
	);
	expect(people).toEqual([{ id: expect.any(String), status: 'active' }]);
	const { rows: attendance } = await db.query(
		'SELECT morning_matched FROM daily_person_attendance WHERE person_id = $1',
		[people[0].id]
	);
	expect(attendance).toEqual([{ morning_matched: true }]);
	expect(
		await count('SELECT 1 FROM attendance_face_evidence WHERE session_id = $1', [sessionB])
	).toBe(1);
	const { rows: flag } = await db.query(
		'SELECT reviewed, resolution, resolved_person_id, resolved_by_admin_id FROM fraud_flags WHERE id = $1',
		[flagId]
	);
	expect(flag[0]).toEqual({
		reviewed: true,
		resolution: 'not_fraud',
		resolved_person_id: people[0].id,
		resolved_by_admin_id: adminAccount.id
	});
	expect(
		await count(
			`SELECT 1 FROM admin_audit_log WHERE action = 'fraud_flag_not_fraud' AND target_id = $1`,
			[flagId]
		)
	).toBe(1);
});

test('FRD-08 admin "not fraud" reuses the flagged pump’s existing worker', async () => {
	const admin = await login((await createAdmin()).email);
	const [a, b] = await sameAreaPumps(2);
	// B already knows this worker from an earlier day.
	const earlier = await recordSession(b.context, ['FRD08known']);
	await shiftBack(earlier, 24 * 60, true);
	await db.query(`UPDATE attendance_sessions SET pairing_status = 'expired' WHERE id = $1`, [
		earlier
	]);
	await recordSession(a.context, ['FRD08known']);
	const sessionB = await submitAndWait(b.context, [{ identity: 'FRD08known', similarity: 0.9 }]);
	const { rows } = await db.query('SELECT id FROM fraud_flags WHERE session_id = $1', [sessionB]);
	expect(rows).toHaveLength(1);

	expect((await action(admin, '/admin/fraud-flags?/notFraud', { id: rows[0].id })).type).toBe(
		'success'
	);
	expect(await count('SELECT 1 FROM persons WHERE pump_id = $1', [b.id])).toBe(1);
	expect(await count('SELECT 1 FROM daily_person_attendance WHERE pump_id = $1', [b.id])).toBe(2);
});

test('FRD-11 confirm fraud keeps the worker absent, and a resolved flag cannot be resolved again', async () => {
	const admin = await login((await createAdmin()).email);
	const { b, flagId } = await flaggedAtB('FRD11');
	expect((await action(admin, '/admin/fraud-flags?/review', { id: flagId })).type).toBe('success');
	const { rows } = await db.query('SELECT resolution FROM fraud_flags WHERE id = $1', [flagId]);
	expect(rows[0].resolution).toBe('confirmed_fraud');
	expect(await count('SELECT 1 FROM daily_person_attendance WHERE pump_id = $1', [b.id])).toBe(0);

	const again = await action(admin, '/admin/fraud-flags?/notFraud', { id: flagId });
	expect(again.type).toBe('failure');
	expect(await count('SELECT 1 FROM daily_person_attendance WHERE pump_id = $1', [b.id])).toBe(0);
});

test('FRD-12 the pump sees the held face from its own photo, not the other pump’s crop', async () => {
	const { b, sessionB, flagId } = await flaggedAtB('FRD12');
	const ownFace = 'data:image/jpeg;base64,RlJEMTJvd24=';
	await db.query(`UPDATE fraud_flags SET face_crop_url = $2 WHERE id = $1`, [flagId, ownFace]);
	await db.query(
		`UPDATE person_face_vectors SET source_photo_crop_url = 'data:image/jpeg;base64,b3RoZXI='
		 WHERE person_id = (SELECT person_id FROM fraud_flags WHERE id = $1)`,
		[flagId]
	);
	const status = await (await b.context.get(`/api/attendance/status/${sessionB}`)).json();
	expect(status.fraud_flags).toHaveLength(1);
	expect(status.fraud_flags[0].source_photo_crop_url).toBe(ownFace);
});

test('FRD-13 the admin turns test mode on and off: fraud check off, banner, audited', async () => {
	const adminAccount = await createAdmin();
	const admin = await login(adminAccount.email);
	try {
		// No server setting needed: the switch is always on the settings page.
		const settings = await (await admin.get('/admin/settings')).text();
		expect(settings).toContain('data-testid="test-mode-section"');
		expect(settings).toMatch(/data-testid="test-mode-state"[^>]*>Off</);

		const on = await action(admin, '/admin/settings?/testMode', { on: 'true' });
		expect(on.type).toBe('success');
		const home = await (await admin.get('/admin')).text();
		expect(home).toContain('data-testid="test-mode-banner"');
		expect(home).toContain(adminAccount.email);
		expect(home).toContain('emails are not sent');

		// Same person at two pumps of one Area: no flag, counted as a worker at both.
		const [a, b] = await sameAreaPumps(2);
		await recordSession(a.context, ['FRD13off']);
		const sessionB = await submitAndWait(b.context, ['FRD13off']);
		expect(await fraudFlagsOn(sessionB)).toBe(0);
		expect(await count('SELECT 1 FROM persons WHERE pump_id = $1', [b.id])).toBe(1);

		const off = await action(admin, '/admin/settings?/testMode', { on: 'false' });
		expect(off.type).toBe('success');
		expect(await (await admin.get('/admin')).text()).not.toContain('test-mode-banner');
		// The old env-gated key (removed by migration 038) never switches the check off.
		await db.query(
			`INSERT INTO app_settings (key, value) VALUES ('fraud_check_disabled', 'true')
			 ON CONFLICT (key) DO UPDATE SET value = 'true'`
		);
		const [c, d] = await sameAreaPumps(2);
		await recordSession(c.context, ['FRD13on']);
		expect(await fraudFlagsOn(await submitAndWait(d.context, ['FRD13on']))).toBe(1);

		// Reset to production defaults also turns test mode off.
		await action(admin, '/admin/settings?/testMode', { on: 'true' });
		expect((await action(admin, '/admin/settings?/reset', {})).type).toBe('success');
		expect(await count(`SELECT 1 FROM app_settings WHERE key = 'test_mode'`)).toBe(0);

		const audit = await db.query(
			`SELECT details FROM admin_audit_log WHERE admin_id = $1 AND action = 'set_test_mode'
			 ORDER BY created_at`,
			[adminAccount.id]
		);
		expect(audit.rows.map((row) => row.details.on)).toEqual([true, false, true]);
	} finally {
		await db.query(`DELETE FROM app_settings WHERE key IN ('test_mode', 'fraud_check_disabled')`);
	}
});
