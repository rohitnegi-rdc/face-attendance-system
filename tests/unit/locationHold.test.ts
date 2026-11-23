// Unit tests for the shift start location hold (worker/locationHold.js): a held start first waits
// for the pump GPS and clears on its own when the pump shows up near the photo spot; otherwise, once
// the wait is over, each plant manager and Area monitor gets one simple email with Approve and Reject
// buttons whose links carry their own signed token.
// Run: npm run test:unit (scripts/run-unit.mjs).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
	clearByLaterGps,
	askDueHolds,
	readLocationToken,
	renderLocationEmail,
	holdMinutes,
	DEFAULT_HOLD_MINUTES
} from '../../worker/locationHold.js';
import { area, db, pump, session } from './fixtures';

const SECRET = 'unit-secret-at-least-32-characters-long!!';
const LAT = 9.9312;
const LNG = 76.2673;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the mailer's message, untyped JS
type Mail = { message: any; meta: { sessionId: string; testMode: boolean; emailOn: boolean } };
let mails: Mail[] = [];
let logs: { level: string; meta: { sessionId?: string }; text: string }[] = [];
const sendMail = async (message: unknown, _log: unknown, meta: unknown) => {
	mails.push({ message, meta } as Mail);
};
const log = (level: string, meta: object, text: string) => {
	logs.push({ level, meta, text });
};
const testModeOff = async () => false;
const testModeOnFn = async () => true;

async function manager(name: string, { monitor = false, email = '' } = {}) {
	const { rows } = await db.query(
		`INSERT INTO plant_managers (name, email, password_hash, is_monitor)
		 VALUES ($1, $2, 'x', $3) RETURNING id, email`,
		[name, email || `${name.toLowerCase()}.${randomUUID().slice(0, 8)}@unit.test`, monitor]
	);
	return rows[0] as { id: string; email: string };
}

// A plant with its pump, one plant manager, one Area monitor and a business head (never asked).
async function site() {
	const { areaId, plantId } = await area();
	const pumpId = await pump(plantId);
	const pm = await manager('Ravi');
	const monitor = await manager('Meena', { monitor: true });
	const head = await manager('Bala');
	await db.query('INSERT INTO plant_manager_assignments (plant_id, manager_id) VALUES ($1, $2)', [
		plantId,
		pm.id
	]);
	await db.query('INSERT INTO monitor_areas (manager_id, area_id) VALUES ($1, $2)', [
		monitor.id,
		areaId
	]);
	await db.query('INSERT INTO business_head_plants (plant_id, manager_id) VALUES ($1, $2)', [
		plantId,
		head.id
	]);
	return { areaId, plantId, pumpId, pm, monitor, head };
}

// A start held by the location check, sent `sentAgo` minutes ago, asked after `askIn` minutes.
async function held(
	pumpId: string,
	{ issue = 'too_far', sentAgo = 5, askIn = 25, distance = 850 } = {}
) {
	const id = await session(pumpId, '2026-09-20', 'morning', 'completed');
	await db.query(
		`UPDATE attendance_sessions
		 SET location_status = 'pending', location_issue = $2, location_distance_m = $3,
		     gps_lat = CASE WHEN $2 = 'no_phone_location' THEN NULL ELSE $4::float8 END,
		     gps_lng = CASE WHEN $2 = 'no_phone_location' THEN NULL ELSE $5::float8 END,
		     submitted_at = now() - make_interval(mins => $6),
		     location_ask_at = now() + make_interval(mins => $7),
		     location_link_base = 'https://attendance.example'
		 WHERE id = $1`,
		[id, issue, issue === 'too_far' ? distance : null, LAT, LNG, sentAgo, askIn]
	);
	return id;
}

async function reading(pumpId: string, lat: number, lng: number, minutesAgo: number) {
	await db.query(
		`INSERT INTO pump_locations (pump_id, lat, lng, recorded_at)
		 VALUES ($1, $2, $3, now() - make_interval(mins => $4))`,
		[pumpId, lat, lng, minutesAgo]
	);
}

const row = async (id: string) =>
	(
		await db.query(
			`SELECT location_status, location_note, location_asked_at, location_auto_cleared_at
			 FROM attendance_sessions WHERE id = $1`,
			[id]
		)
	).rows[0];

const mailsFor = (id: string) => mails.filter((m) => m.meta.sessionId === id);

describe('location hold', () => {
	before(async () => {
		await db.connect();
		process.env.JWT_SECRET = SECRET;
	});
	after(async () => {
		await db.query(
			"DELETE FROM app_settings WHERE key IN ('location_approval_email', 'location_hold_minutes')"
		);
		await db.end();
	});
	beforeEach(() => {
		mails = [];
		logs = [];
	});

	test('the wait is 30 minutes unless an admin set another', async () => {
		await db.query("DELETE FROM app_settings WHERE key = 'location_hold_minutes'");
		assert.equal(await holdMinutes(db), DEFAULT_HOLD_MINUTES);
		assert.equal(DEFAULT_HOLD_MINUTES, 30);
		await db.query("INSERT INTO app_settings (key, value) VALUES ('location_hold_minutes', '0')");
		assert.equal(await holdMinutes(db), 0);
		await db.query("DELETE FROM app_settings WHERE key = 'location_hold_minutes'");
	});

	test('a pump GPS reading near the photo spot clears the start by itself, with a note', async () => {
		const s = await site();
		const id = await held(s.pumpId);
		await reading(s.pumpId, LAT + 0.0004, LNG, 1); // about 45 m away, after the photo
		await clearByLaterGps(db, log);
		const r = await row(id);
		assert.equal(r.location_status, 'approved');
		assert.ok(r.location_auto_cleared_at);
		assert.match(
			r.location_note,
			/^Cleared automatically: the pump GPS was \d+ m from the photo spot at /
		);
		assert.ok(
			logs.some((l) => l.text.includes('cleared automatically') && l.meta.sessionId === id)
		);
		// Already decided: nobody is asked later.
		await db.query(
			"UPDATE attendance_sessions SET location_ask_at = now() - interval '1 minute' WHERE id = $1",
			[id]
		);
		await askDueHolds(db, log, testModeOff, sendMail);
		assert.equal(mailsFor(id).length, 0);
	});

	test('a far reading, or one long before the photo, does not clear it', async () => {
		const s = await site();
		const id = await held(s.pumpId, { sentAgo: 5 });
		await reading(s.pumpId, LAT + 0.01, LNG, 1); // about 1.1 km away
		await reading(s.pumpId, LAT, LNG, 120); // at the spot, but 2 hours ago
		await clearByLaterGps(db, log);
		assert.equal((await row(id)).location_status, 'pending');
	});

	test('nobody is asked before the wait is over', async () => {
		const s = await site();
		const id = await held(s.pumpId, { askIn: 20 });
		await askDueHolds(db, log, testModeOff, sendMail);
		assert.equal(mailsFor(id).length, 0);
		assert.equal((await row(id)).location_asked_at, null);
	});

	test('when the wait is over, each plant manager and monitor gets their own email, once', async () => {
		await db.query(
			`INSERT INTO app_settings (key, value) VALUES ('location_approval_email', 'on')
			 ON CONFLICT (key) DO UPDATE SET value = 'on'`
		);
		const s = await site();
		const id = await held(s.pumpId, { askIn: -1 });
		await askDueHolds(db, log, testModeOff, sendMail);
		const sent = mailsFor(id);
		assert.deepEqual(sent.map((m) => m.message.to).sort(), [s.monitor.email, s.pm.email].sort());
		assert.ok(!sent.some((m) => m.message.to === s.head.email), 'business head is not asked');
		for (const { message, meta } of sent) {
			assert.equal(meta.emailOn, true);
			assert.equal(meta.testMode, false);
			assert.match(message.approveUrl, /^https:\/\/attendance\.example\/location\/.+\?do=approve$/);
			assert.match(message.rejectUrl, /\?do=reject$/);
			const token = message.approveUrl.split('/location/')[1].split('?')[0];
			const expected = message.to === s.pm.email ? s.pm.id : s.monitor.id;
			assert.deepEqual(readLocationToken(SECRET, token), { sessionId: id, managerId: expected });
			assert.equal(readLocationToken('another-secret-at-least-32-characters', token), null);
			assert.match(message.subject, /^Please decide: .+ shift start was 850 m from the pump$/);
			assert.ok(message.html.includes('>Approve</a>'));
			assert.ok(message.html.includes('>Reject</a>'));
			assert.ok(message.html.includes('Until you decide, this shift start is not counted.'));
			assert.ok(message.text.includes(`Approve: ${message.approveUrl}`));
		}
		assert.ok((await row(id)).location_asked_at);
		// A second sweep asks nobody again.
		mails = [];
		await askDueHolds(db, log, testModeOff, sendMail);
		assert.equal(mailsFor(id).length, 0);
	});

	test('a phone that shared no location is not cleared by the pump GPS', async () => {
		const s = await site();
		const id = await held(s.pumpId, { issue: 'no_phone_location', askIn: 0 });
		await reading(s.pumpId, LAT, LNG, 1);
		await clearByLaterGps(db, log);
		assert.equal((await row(id)).location_status, 'pending');
		await askDueHolds(db, log, testModeOff, sendMail);
		assert.equal(mailsFor(id).length, 2);
		assert.match(mailsFor(id)[0].message.subject, /place not confirmed$/);
	});

	test('switch off and test mode reach the mailer, which logs instead of sending', async () => {
		await db.query("UPDATE app_settings SET value = 'off' WHERE key = 'location_approval_email'");
		const s = await site();
		const id = await held(s.pumpId, { askIn: -1 });
		await askDueHolds(db, log, testModeOnFn, sendMail);
		assert.ok(mailsFor(id).length > 0);
		for (const { meta } of mailsFor(id)) {
			assert.equal(meta.emailOn, false);
			assert.equal(meta.testMode, true);
		}
	});

	test('nobody with a mailbox: a warning for the admin logs, no email', async () => {
		const { plantId } = await area();
		const pumpId = await pump(plantId);
		const pm = await manager('Login', { email: `pm.${randomUUID().slice(0, 6)}@plants.rdc` });
		await db.query('INSERT INTO plant_manager_assignments (plant_id, manager_id) VALUES ($1, $2)', [
			plantId,
			pm.id
		]);
		const id = await held(pumpId, { askIn: -1 });
		await askDueHolds(db, log, testModeOff, sendMail);
		assert.equal(mailsFor(id).length, 0);
		assert.ok(
			logs.some(
				(l) =>
					l.level === 'warn' &&
					l.meta.sessionId === id &&
					l.text.includes('no plant manager or monitor')
			)
		);
	});

	test('the email reads simply and escapes names', () => {
		const email = renderLocationEmail(
			{
				pump_code: 'KL<1>',
				plant_name: 'Kochi',
				sent_at: '7:05 am, Wed, 18 Nov 2026',
				location_issue: 'too_far',
				location_distance_m: 420,
				waited_minutes: 30,
				faces: 3,
				photo_cid: null
			},
			{ name: 'Sebastian Shine' },
			'https://x/location/t?do=approve',
			'https://x/location/t?do=reject'
		);
		assert.ok(email.html.includes('Hello Sebastian,'));
		assert.ok(email.html.includes('KL&#60;1&#62;'));
		assert.ok(!email.html.includes('KL<1>'));
		assert.ok(
			email.text.includes("The operator's phone was 420 m from the pump. It must be within 100 m.")
		);
		assert.ok(email.text.includes("We watched the pump's GPS for 30 minutes after the photo."));
		assert.ok(email.text.includes('3 people in the photo.'));
		assert.ok(email.text.includes('1. Call the operator of pump KL<1>.'));
	});
});
