// REM-01 / REM-02: shift end reminders by Web Push (migration 040, worker/endReminders.js). A pump
// phone saves its push subscription; the moment the evening gap (9 hours) has passed since the
// shift start the worker sends the first reminder, then one every 15 minutes while the shift end
// is still missing, four at most. A phone the push service no longer knows (410) is removed; a
// shift that already ended gets nothing. The stub AI server stands in for the push service and
// keeps every message, so REM-02 decrypts it like the phone and hands it to the real service
// worker, which must show it.
import { createDecipheriv, createECDH, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { chromium, expect, test, type APIRequestContext } from '@playwright/test';
import {
	BASE_URL,
	PASSWORD,
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
const EVERY_MINUTES = 15;
const MAX_REMINDERS = 4;

// A phone's push keys: the private half stays here so the test can read what the worker sent.
function phoneKeys() {
	const ecdh = createECDH('prime256v1');
	ecdh.generateKeys();
	const auth = randomBytes(16);
	return {
		ecdh,
		auth,
		json: {
			p256dh: ecdh.getPublicKey().toString('base64url'),
			auth: auth.toString('base64url')
		}
	};
}

async function savePhone(context: APIRequestContext, endpoint: string) {
	return context.post('/api/pump/push', { data: { endpoint, keys: phoneKeys().json } });
}

type Received = { body: string; headers: Record<string, string> };

async function received(id: string) {
	return (await (await fetch(`${STUB_URL}/__pushes/${id}`)).json()) as {
		pushes: number;
		messages: Received[];
	};
}

async function pushesTo(id: string) {
	return (await received(id)).pushes;
}

// Web Push message encryption (RFC 8291, aes128gcm), read the way the phone's browser does.
function decrypt(message: Received, keys: ReturnType<typeof phoneKeys>) {
	const data = Buffer.from(message.body, 'base64');
	const salt = data.subarray(0, 16);
	const idLength = data[20];
	const serverKey = data.subarray(21, 21 + idLength);
	const cipherText = data.subarray(21 + idLength);
	const shared = keys.ecdh.computeSecret(serverKey);
	const keyInfo = Buffer.concat([
		Buffer.from('WebPush: info\0'),
		keys.ecdh.getPublicKey(),
		serverKey
	]);
	const ikm = Buffer.from(hkdfSync('sha256', shared, keys.auth, keyInfo, 32));
	const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
	const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
	const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
	decipher.setAuthTag(cipherText.subarray(cipherText.length - 16));
	const plain = Buffer.concat([
		decipher.update(cipherText.subarray(0, cipherText.length - 16)),
		decipher.final()
	]);
	// The record ends with the 0x02 delimiter and zero padding.
	return plain.subarray(0, plain.lastIndexOf(2)).toString('utf8');
}

const sentFor = async (sessionId: string) =>
	(await db.query('SELECT end_reminders_sent FROM attendance_sessions WHERE id = $1', [sessionId]))
		.rows[0].end_reminders_sent as number;

// The last reminder went out a little over 15 minutes ago.
const fifteenMinutesPass = (sessionId: string) =>
	db.query(
		`UPDATE attendance_sessions
		 SET end_reminder_at = now() - make_interval(mins => $2 + 1) WHERE id = $1`,
		[sessionId, EVERY_MINUTES]
	);

// Several worker polls (one a second in regression) with nothing new.
const quietFor = () => new Promise((r) => setTimeout(r, 3000));

test('REM-01 the first reminder when the shift can end, then every 15 minutes, four at most', async () => {
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
	await shiftBack(start, GAP_MINUTES - 1);
	await quietFor();
	expect(await pushesTo(phone)).toBe(0);

	// The gap passes: the first reminder goes at once (within a worker poll).
	await shiftBack(start, 2);
	await expect.poll(() => pushesTo(phone), { timeout: 10_000 }).toBe(1);
	expect(await sentFor(start)).toBe(1);
	// The phone that left (410) is removed after its one try.
	expect(await pushesTo(gone)).toBe(1);
	expect(
		(await db.query('SELECT 1 FROM push_subscriptions WHERE endpoint LIKE $1', [`%${gone}`]))
			.rowCount
	).toBe(0);

	// Nothing more until 15 minutes have passed.
	await quietFor();
	expect(await pushesTo(phone)).toBe(1);

	for (let reminder = 2; reminder <= MAX_REMINDERS; reminder++) {
		await fifteenMinutesPass(start);
		await expect.poll(() => pushesTo(phone), { timeout: 10_000 }).toBe(reminder);
		expect(await sentFor(start)).toBe(reminder);
	}

	// Never a fifth.
	await fifteenMinutesPass(start);
	await quietFor();
	expect(await pushesTo(phone)).toBe(MAX_REMINDERS);
	expect(await sentFor(start)).toBe(MAX_REMINDERS);
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

// Chrome's recommended flow: nothing asks on its own. A pump phone that has not answered sees
// the Enable notifications sheet before the guide; only its button opens Chrome's question; Not
// now lets the guide through. Signing in (any role) never asks.
test('REM-01 only the Enable notifications button asks, the sheet comes before the guide', async ({
	page
}) => {
	await page.addInitScript(() => {
		const store = window.sessionStorage;
		Object.defineProperty(Notification, 'permission', { get: () => 'default' });
		Notification.requestPermission = async () => {
			store.setItem('asked', String(Number(store.getItem('asked') ?? 0) + 1));
			return 'default';
		};
	});
	const asked = () => page.evaluate(() => Number(sessionStorage.getItem('asked') ?? 0));

	const admin = await createAdmin();
	await page.goto('/login');
	await page.getByTestId('login-email').fill(admin.email);
	await page.getByTestId('login-password').fill(PASSWORD);
	await page.getByTestId('login-submit').click();
	await page.waitForURL(/\/admin/);
	expect(await asked()).toBe(0);
	await page.context().clearCookies();

	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	await page.goto('/login');
	await page.getByTestId('login-email').fill(pump.email);
	await page.getByTestId('login-password').fill(PASSWORD);
	await page.getByTestId('login-submit').click();
	await page.waitForURL(/\/pump$/);
	const sheet = page.getByTestId('pump-reminders');
	await expect(sheet).toHaveAttribute('data-state', 'ask');
	await expect(page.getByTestId('pump-guide')).toHaveCount(0);
	// A tap elsewhere asks nothing; only the button does, once per tap.
	await page.mouse.click(10, 300);
	expect(await asked()).toBe(0);
	await page.getByTestId('reminders-allow').click();
	await expect.poll(asked).toBe(1);
	// No answer: the button stays. Not now lets the guide through.
	await expect(sheet).toHaveAttribute('data-state', 'ask');
	await page.getByTestId('reminders-later').click();
	await expect(sheet).toHaveCount(0);
	await expect(page.getByTestId('pump-guide')).toBeVisible();
	expect(await asked()).toBe(1);
});

// The whole chain in a phone-sized browser: a new pump phone signs in, sees the Enable
// notifications sheet before the guide, taps it, allows, its subscription is saved, the worker sends the four reminders on time, each
// decrypts to the right words, and the app's service worker shows it as a notification. Chromium
// under Playwright has no push service of its own, so the subscription points at the stub and
// each message is handed to the service worker as a real push event (DevTools protocol).
test('REM-02 end to end: Enable notifications, reminders sent and shown on the phone', async ({}, testInfo) => {
	const browser = await chromium.launch({ channel: 'chromium' });
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const phoneId = randomUUID();
	const keys = phoneKeys();
	const endpoint = `${STUB_URL}/push/${phoneId}`;

	const context = await browser.newContext({
		baseURL: BASE_URL,
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true
	});
	// The service worker may show notifications; the page itself starts as a phone that has not
	// answered yet. The browser's question is answered "Allow" after a moment, like a person
	// reading it; the answer and where it was asked survive the move from /login to /pump.
	await context.grantPermissions(['notifications']);
	await context.addInitScript(
		({ endpoint, json }) => {
			const store = window.sessionStorage;
			Object.defineProperty(Notification, 'permission', {
				get: () => (store.getItem('answered') ?? 'default') as NotificationPermission
			});
			Notification.requestPermission = async () => {
				store.setItem('asked', String(Number(store.getItem('asked') ?? 0) + 1));
				store.setItem('askedOn', location.pathname);
				await new Promise((r) => setTimeout(r, 800));
				store.setItem('answered', 'granted');
				return 'granted';
			};
			let subscription: PushSubscription | null = null;
			PushManager.prototype.getSubscription = async () => subscription;
			PushManager.prototype.subscribe = async () => {
				subscription = {
					endpoint,
					toJSON: () => ({ endpoint, keys: json })
				} as unknown as PushSubscription;
				return subscription;
			};
		},
		{ endpoint, json: keys.json }
	);
	const asked = () =>
		page.evaluate(() => ({
			times: Number(sessionStorage.getItem('asked') ?? 0),
			on: sessionStorage.getItem('askedOn')
		}));

	// 1. Sign in asks nothing; the pump screen shows Enable notifications before the guide, and
	// its button opens the browser's question.
	const page = await context.newPage();
	await page.goto('/login');
	await page.getByTestId('login-email').fill(pump.email);
	await page.getByTestId('login-password').fill(PASSWORD);
	await page.screenshot({ path: testInfo.outputPath('1-sign-in.png') });
	await page.getByTestId('login-submit').click();
	await page.waitForURL(/\/pump$/);
	expect((await asked()).times).toBe(0);
	await expect(page.getByTestId('pump-reminders')).toHaveAttribute('data-state', 'ask');
	await expect(page.getByTestId('pump-guide')).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath('2-enable-notifications.png') });
	await page.getByTestId('reminders-allow').click();
	await expect.poll(asked).toEqual({ times: 1, on: '/pump' });
	await expect(page.getByTestId('pump-reminders')).toHaveAttribute('data-state', 'on');
	// Answered: the guide comes next, and nothing asks again.
	await expect(page.getByTestId('pump-guide')).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('3-guide-after-enable.png') });
	await page.getByTestId('guide-close').click();
	expect((await asked()).times).toBe(1);

	// 2. This phone is saved for the pump.
	await expect
		.poll(async () =>
			(
				await db.query('SELECT pump_id FROM push_subscriptions WHERE endpoint = $1', [endpoint])
			).rows.map((row) => row.pump_id)
		)
		.toEqual([pump.id]);

	// The app's service worker, and a DevTools handle to push to it.
	const devtools = await context.newCDPSession(page);
	const registrations = new Promise<string>((resolve) => {
		devtools.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
			const found = registrations.find((r: { scopeURL: string; isDeleted: boolean }) =>
				r.scopeURL.startsWith(BASE_URL)
			);
			if (found && !found.isDeleted) resolve(found.registrationId);
		});
	});
	await devtools.send('ServiceWorker.enable');
	const registrationId = await registrations;
	const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
	const shown = () =>
		worker.evaluate(async () => {
			// Runs inside the service worker (no ServiceWorkerGlobalScope type in the test build).
			const sw = self as unknown as { registration: ServiceWorkerRegistration };
			const list = await sw.registration.getNotifications();
			return list.map((n: Notification) => ({
				title: n.title,
				body: n.body,
				tag: n.tag,
				icon: n.icon,
				badge: (n as Notification & { badge?: string }).badge,
				url: n.data?.url as string | undefined
			}));
		});

	// 3. A shift start; nothing before the 9 hours.
	const api = await login(pump.email);
	const start = await recordSession(api, ['rem-e2e-a', 'rem-e2e-b']);
	await quietFor();
	expect(await pushesTo(phoneId)).toBe(0);

	// 4. Each reminder: sent on time, decrypted, shown by the service worker.
	const seen: { title: string; body: string }[] = [];
	for (let reminder = 1; reminder <= MAX_REMINDERS; reminder++) {
		if (reminder === 1) await shiftBack(start, GAP_MINUTES + 1);
		else await fifteenMinutesPass(start);
		await expect.poll(() => pushesTo(phoneId), { timeout: 10_000 }).toBe(reminder);
		const message = (await received(phoneId)).messages[reminder - 1];
		expect(message.headers['content-encoding']).toBe('aes128gcm');
		expect(message.headers.authorization).toMatch(/^vapid t=.+, k=.+/);
		const payload = decrypt(message, keys);
		const content = JSON.parse(payload);
		expect(content.tag).toBe(`shift-end-${start}`);
		if (reminder === 1) {
			expect(content.title).toContain('Time to end the shift');
			expect(content.body).toContain('9 hours are done');
		} else if (reminder === MAX_REMINDERS) {
			expect(content.title).toContain('Last reminder');
			expect(content.body).toContain(`Reminder ${reminder} of ${MAX_REMINDERS}`);
		} else {
			expect(content.title).toContain('Shift end is still pending');
			expect(content.body).toContain(`Reminder ${reminder} of ${MAX_REMINDERS}`);
		}

		await devtools.send('ServiceWorker.deliverPushMessage', {
			origin: new URL(BASE_URL).origin,
			registrationId,
			data: payload
		});
		// One notification per shift: each reminder replaces the one before.
		await expect
			.poll(async () => (await shown()).map((n: { title: string }) => n.title), {
				timeout: 10_000
			})
			.toEqual([content.title]);
		const [notification] = await shown();
		expect(notification.body).toBe(content.body);
		expect(notification.tag).toBe(`shift-end-${start}`);
		expect(notification.url).toBe(new URL('pump', BASE_URL + '/').href);
		// The RDC truck as the notification's picture and status bar badge.
		expect(notification.icon).toBe(new URL('icons/icon-192.png', BASE_URL + '/').href);
		expect(notification.badge).toBe(new URL('icons/badge-96.png', BASE_URL + '/').href);
		seen.push({ title: notification.title, body: notification.body });
	}

	// 5. Never a fifth.
	await fifteenMinutesPass(start);
	await quietFor();
	expect(await pushesTo(phoneId)).toBe(MAX_REMINDERS);

	// What the phone showed, one card per reminder, for the record.
	const escape = (text: string) =>
		text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
	await page.setContent(
		`<body style="margin:0;padding:16px;background:#1f2933;font:15px system-ui">` +
			seen
				.map(
					(n, i) =>
						`<div style="background:#fff;border-radius:14px;padding:12px 14px;margin-bottom:12px">` +
						`<div style="font-size:12px;color:#52606d">Reminder ${i + 1} · Face Attendance</div>` +
						`<div style="font-weight:600;margin:4px 0">${escape(n.title)}</div>` +
						`<div style="white-space:pre-line;color:#323f4b">${escape(n.body)}</div></div>`
				)
				.join('') +
			`</body>`
	);
	await page.screenshot({ path: testInfo.outputPath('3-notifications-shown.png') });
	await context.close();
	await browser.close();
});
