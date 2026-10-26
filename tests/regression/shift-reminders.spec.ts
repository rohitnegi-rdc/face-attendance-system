// REM-01: shift end reminders by Web Push (migration 040, worker/endReminders.js). A pump phone
// saves its push subscription; once the evening gap (9 hours) has passed since the shift start
// the worker sends one reminder, 30 minutes later a second if the shift end is still missing,
// and never a third. A phone the push service no longer knows (410) is removed; a shift that
// already ended gets nothing. The stub AI server stands in for the push service.
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
	STUB_URL,
	createAdmin,
	createArea,
	createPump,
	db,
	login,
	recordSession,
	shiftBack
} from './helpers';

const GAP_MINUTES = 540;

function phoneKeys() {
	const ecdh = createECDH('prime256v1');
	ecdh.generateKeys();
	return {
		p256dh: ecdh.getPublicKey().toString('base64url'),
		auth: randomBytes(16).toString('base64url')
	};
}

async function savePhone(context: APIRequestContext, endpoint: string) {
	return context.post('/api/pump/push', { data: { endpoint, keys: phoneKeys() } });
}

async function pushesTo(id: string) {
	return (await (await fetch(`${STUB_URL}/__pushes/${id}`)).json()).pushes as number;
}

// Several worker polls (one a second in regression) with nothing new.
const quietFor = () => new Promise((r) => setTimeout(r, 3000));

test('REM-01 a shift end reminder at 9 hours, a second after 30 minutes, then none', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const context = await login(pump.email);

	const key = await (await context.get('/api/pump/push')).json();
	expect(key.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
	const admin = await login((await createAdmin()).email);
	expect((await admin.get('/api/pump/push')).status()).toBe(403);
	// The worker posts to the saved address, so nothing but a push service gets in.
	expect((await savePhone(context, 'http://10.0.0.5/internal')).status()).toBe(400);

	const phone = randomUUID();
	const gone = randomUUID();
	expect((await savePhone(context, `${STUB_URL}/push/${phone}`)).status()).toBe(200);
	expect((await savePhone(context, `${STUB_URL}/push-gone/${gone}`)).status()).toBe(200);

	const start = await recordSession(context, ['rem-a', 'rem-b']);
	await quietFor();
	expect(await pushesTo(phone)).toBe(0);

	await shiftBack(start, GAP_MINUTES + 1);
	await expect.poll(() => pushesTo(phone), { timeout: 10_000 }).toBe(1);
	const sent = async () =>
		(await db.query('SELECT end_reminders_sent FROM attendance_sessions WHERE id = $1', [start]))
			.rows[0].end_reminders_sent;
	expect(await sent()).toBe(1);
	// The phone that left (410) is removed after its one try.
	expect(await pushesTo(gone)).toBe(1);
	expect(
		(await db.query('SELECT 1 FROM push_subscriptions WHERE endpoint LIKE $1', [`%${gone}`]))
			.rowCount
	).toBe(0);

	await quietFor();
	expect(await pushesTo(phone)).toBe(1);

	await db.query(
		`UPDATE attendance_sessions SET end_reminder_at = now() - interval '31 minutes' WHERE id = $1`,
		[start]
	);
	await expect.poll(() => pushesTo(phone), { timeout: 10_000 }).toBe(2);
	expect(await sent()).toBe(2);

	await db.query(
		`UPDATE attendance_sessions SET end_reminder_at = now() - interval '2 hours' WHERE id = $1`,
		[start]
	);
	await quietFor();
	expect(await pushesTo(phone)).toBe(2);
});

test('REM-01 a shift that already ended gets no reminder', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const context = await login(pump.email);
	const start = await recordSession(context, ['rem-c']);
	await shiftBack(start, GAP_MINUTES + 1);
	await recordSession(context, ['rem-c']);

	const phone = randomUUID();
	expect((await savePhone(context, `${STUB_URL}/push/${phone}`)).status()).toBe(200);
	await quietFor();
	expect(await pushesTo(phone)).toBe(0);
});
