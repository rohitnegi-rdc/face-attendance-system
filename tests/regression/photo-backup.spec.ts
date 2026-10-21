// BAK: the untouched copy of every upload (db/migrations/025_photo_backups.sql). A clean photo
// drops its copy; a photo that fails or is flagged as fraud keeps it, even after the pump's Retry
// deletes the session. Admin and the plant's own manager can open it, nobody else.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
	count,
	createAdmin,
	createArea,
	createPlantManager,
	createPump,
	db,
	login,
	photo,
	recordSession,
	submit,
	waitForSession
} from './helpers';

async function backupsOf(sessionId: string) {
	const { rows } = await db.query('SELECT * FROM attendance_photo_backups WHERE session_id = $1', [
		sessionId
	]);
	return rows;
}

const exists = (file: string) =>
	fs.access(path.resolve(file)).then(
		() => true,
		() => false
	);

test('BAK-01 a photo processed cleanly leaves no copy behind', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const context = await login(pump.email);
	const submitted = await submit(context, await photo(['BAK01']));
	expect(submitted.status).toBe(202);

	// The copy exists as soon as the upload is accepted (unless the worker was already faster).
	const { rows: early } = await db.query(
		'SELECT file_path FROM attendance_photo_backups WHERE session_id = $1',
		[submitted.body.session_id]
	);
	const session = await waitForSession(submitted.body.session_id, ['review', 'failed']);
	expect(session.status).toBe('review');
	expect(await backupsOf(session.id)).toHaveLength(0);
	if (early[0]) expect(await exists(early[0].file_path)).toBe(false);
});

test('BAK-02 a photo that keeps failing keeps its original, also after Retry, for admin and its manager only', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const manager = await createPlantManager(plantId);
	const otherManager = await createPlantManager((await createArea()).plantId);
	const admin = await createAdmin();
	const context = await login(pump.email);
	const buffer = await photo(['BAK02'], { fail: true });
	const submitted = await submit(context, buffer);
	expect(submitted.status).toBe(202);

	const session = await waitForSession(submitted.body.session_id, ['failed', 'review'], 45_000);
	expect(session.status).toBe('failed');
	const [kept] = await backupsOf(session.id);
	expect(kept.status).toBe('failed');
	expect(kept.reason).toBe(session.error_reason);
	expect(kept.error_detail).toMatch(/500/);
	// The untouched upload, byte for byte.
	expect(Buffer.compare(await fs.readFile(path.resolve(kept.file_path)), buffer)).toBe(0);

	// Retry deletes the session and its photo; the copy stays.
	const retried = await context.post(`/api/attendance/retry/${session.id}`);
	expect(retried.status(), await retried.text()).toBe(200);
	const { rows } = await db.query('SELECT * FROM attendance_photo_backups WHERE id = $1', [
		kept.id
	]);
	expect(rows[0].session_id).toBeNull();
	expect(rows[0].status).toBe('failed');
	expect(await exists(kept.file_path)).toBe(true);

	const url = `/api/attendance/backup/${kept.id}`;
	const adminContext = await login(admin.email);
	const managerContext = await login(manager.email);
	const otherContext = await login(otherManager.email);
	const fromAdmin = await adminContext.get(url);
	expect(fromAdmin.status()).toBe(200);
	expect(Buffer.compare(await fromAdmin.body(), buffer)).toBe(0);
	expect((await managerContext.get(url)).status()).toBe(200);
	expect((await otherContext.get(url)).status()).toBe(404);
	expect((await context.get(url)).status()).toBe(403);

	// Listed on both pages, and only for the plant's own manager.
	expect(await (await adminContext.get('/admin/photo-backups')).text()).toContain(pump.code);
	expect(await (await managerContext.get('/plant-manager/photo-backups')).text()).toContain(
		pump.code
	);
	expect(await (await otherContext.get('/plant-manager/photo-backups')).text()).not.toContain(
		pump.code
	);
});

test('BAK-03 a photo flagged as fraud at another pump keeps its copy', async () => {
	const { plantId } = await createArea();
	const a = await createPump(plantId);
	const b = await createPump(plantId);
	await recordSession(await login(a.email), ['BAK03']);
	const submitted = await submit(await login(b.email), await photo(['BAK03']));
	expect(submitted.status).toBe(202);

	const session = await waitForSession(submitted.body.session_id, ['review', 'failed']);
	expect(await count('SELECT 1 FROM fraud_flags WHERE session_id = $1', [session.id])).toBe(1);
	const [kept] = await backupsOf(session.id);
	expect(kept.status).toBe('fraud');
	expect(await exists(kept.file_path)).toBe(true);
});

test('BAK-04 a rejected upload (same photo twice) saves no copy', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const context = await login(pump.email);
	const buffer = await photo(['BAK04']);
	const first = await submit(context, buffer);
	expect(first.status).toBe(202);
	await waitForSession(first.body.session_id, ['review']);
	const before = await count('SELECT 1 FROM attendance_photo_backups WHERE pump_id = $1', [
		pump.id
	]);

	const second = await submit(context, buffer);
	expect(second.status).toBeGreaterThanOrEqual(400);
	expect(await count('SELECT 1 FROM attendance_photo_backups WHERE pump_id = $1', [pump.id])).toBe(
		before
	);
});
