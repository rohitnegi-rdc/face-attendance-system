// FIX-06: the admin removes a worker for good (a test photo). Their faces, days, totals and
// evidence are deleted, the other workers in the same photo keep theirs, the photo stays, and the
// removal is in admin_audit_log.
import { test, expect } from '@playwright/test';
import {
	action,
	createAdmin,
	createArea,
	createPump,
	count,
	db,
	login,
	recordSession
} from './helpers';

test('FIX-06 admin removes a worker; the others in the photo stay', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const pumpContext = await login(pump.email);
	const sessionId = await recordSession(pumpContext, [`GONE-${pump.code}`, `STAY-${pump.code}`]);
	const { rows } = await db.query(
		'SELECT id FROM persons WHERE pump_id = $1 ORDER BY display_seq',
		[pump.id]
	);
	expect(rows.length).toBeGreaterThanOrEqual(2);
	const [gone, stay] = rows.map((row) => row.id as string);

	const admin = await createAdmin();
	const adminContext = await login(admin.email);
	const result = await action(adminContext, `/admin/persons/${gone}?/removeWorker`, {});
	expect(result.type).toBe('redirect');

	for (const table of [
		'person_face_vectors',
		'attendance_face_evidence',
		'daily_person_attendance',
		'person_attendance_yearly'
	]) {
		expect(await count(`SELECT 1 FROM ${table} WHERE person_id = $1`, [gone]), table).toBe(0);
	}
	expect(await count('SELECT 1 FROM persons WHERE id = $1', [gone])).toBe(0);
	expect(await count('SELECT 1 FROM persons WHERE id = $1', [stay])).toBe(1);
	expect(await count('SELECT 1 FROM daily_person_attendance WHERE person_id = $1', [stay])).toBe(1);
	expect(await count('SELECT 1 FROM attendance_sessions WHERE id = $1', [sessionId])).toBe(1);
	expect(
		await count(`SELECT 1 FROM admin_audit_log WHERE action = 'remove_worker' AND target_id = $1`, [
			gone
		])
	).toBe(1);

	// The removed worker's page is gone.
	expect((await adminContext.get(`/admin/persons/${gone}`)).status()).toBe(404);
});
