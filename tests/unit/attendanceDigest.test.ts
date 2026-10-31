// Unit tests for the 9 am attendance tracker (worker/attendanceDigest.js, renderAttendanceDigest in
// worker/digestEmail.js): one email per Area, its Active and Idle pumps (a zero in red), who gets
// it, who is copied, and the counts per pump.
// Run: npm run test:unit (scripts/run-unit.mjs).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { sendAttendanceDigests } from '../../worker/attendanceDigest.js';
import { renderAttendanceDigest } from '../../worker/digestEmail.js';
import { admin, area, db, person, pump, session } from './fixtures';

// The email at 9:30 am IST on 1 Oct is about 30 Sep. No other test uses these days.
const DAY = '2026-09-30';
const AT_0930 = new Date('2026-10-01T04:00:00Z');
const AT_0830 = new Date('2026-10-01T03:00:00Z');

type Sent = {
	to: string[];
	cc: string[];
	area: string;
	day: string;
	areas: any[];
	totals: any;
};

let sent: Sent[] = [];
const send = async (message: Sent) => {
	sent.push(message);
};
const quiet = () => {};
const testModeOff = async () => false;

async function manager(name: string, { monitor = false, disabled = false } = {}) {
	const { rows } = await db.query(
		`INSERT INTO plant_managers (name, email, password_hash, is_monitor, disabled_at)
		 VALUES ($1, $2, 'x', $3, $4) RETURNING id, email`,
		[name, `${name}.${randomUUID().slice(0, 8)}@unit.test`, monitor, disabled ? new Date() : null]
	);
	return rows[0] as { id: string; email: string };
}

// A worker counted at the start, the end or both on DAY.
async function worker(pumpId: string, start: boolean, end: boolean) {
	const id = await person(pumpId);
	await db.query(
		`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched, evening_matched)
		 VALUES ($1, $2, $3, $4, $5)`,
		[id, pumpId, DAY, start, end]
	);
}

async function code(pumpId: string) {
	const { rows } = await db.query('SELECT pump_code FROM pumps WHERE id = $1', [pumpId]);
	return rows[0].pump_code as string;
}

async function areaName(areaId: string) {
	const { rows } = await db.query('SELECT name FROM areas WHERE id = $1', [areaId]);
	return rows[0].name as string;
}

// Area A: plant 1 with a pump that sent both photos, a pump whose only photo failed, a silent Idle
// pump, an Inactive pump with photos and a pump added after DAY; plant 2 (its manager disabled)
// with a start-only pump. Area B: one pump. A monitor watches Area A. Area C: an Active pump with
// no photo. Area D: only an Inactive pump.
async function build() {
	const a = await area();
	const { rows: p2 } = await db.query(
		"INSERT INTO plants (area_id, name) VALUES ($1, 'PLANT2-' || substr(md5(random()::text), 1, 8)) RETURNING id",
		[a.areaId]
	);
	const b = await area();
	const c = await area();
	const d = await area();
	// Area E has a pump with photos but is not ticked at /admin/settings.
	const e = await area();
	await db.query('UPDATE areas SET digest_enabled = true WHERE id = ANY($1)', [
		[a.areaId, b.areaId, c.areaId, d.areaId]
	]);
	const offArea = await pump(e.plantId);
	const full = await pump(a.plantId);
	const failedOnly = await pump(a.plantId);
	const silent = await pump(a.plantId);
	const startOnly = await pump(p2[0].id);
	const other = await pump(b.plantId);
	const noPhoto = await pump(c.plantId);
	const closed = await pump(a.plantId);
	const closedOnly = await pump(d.plantId);
	const added = await pump(a.plantId);
	// Never given a status, so Inactive (every pump starts so): sends photos, not listed.
	const unset = await pump(a.plantId);
	await db.query("UPDATE pumps SET created_at = '2026-09-01' WHERE id = ANY($1)", [
		[full, failedOnly, silent, startOnly, other, noPhoto, closed, closedOnly, offArea, unset]
	]);
	await session(offArea, DAY, 'morning');
	await worker(offArea, true, true);
	// Statuses by day (migration 046): `full` closes only after DAY, so DAY still counts it.
	const status = (pumpId: string, day: string, value: string) =>
		db.query(
			`INSERT INTO pump_day_status (pump_id, day, status, set_by_role, set_by_id, set_by_name)
			 VALUES ($1, $2, $3, 'admin', gen_random_uuid(), 'unit')`,
			[pumpId, day, value]
		);
	for (const id of [full, failedOnly, startOnly, other, noPhoto, offArea, added])
		await status(id, '2026-09-01', 'active');
	// `full` works at a site, typed with its status; it still holds on DAY.
	await db.query(
		"UPDATE pump_day_status SET site_name = 'Lodha Palava' WHERE pump_id = $1 AND day = '2026-09-01'",
		[full]
	);
	await session(unset, DAY, 'morning');
	await worker(unset, true, true);
	await status(silent, '2026-09-10', 'idle');
	await status(closed, '2026-09-10', 'inactive');
	await status(closedOnly, '2026-09-10', 'inactive');
	await status(full, '2026-10-01', 'inactive');
	await session(closed, DAY, 'morning');
	await worker(closed, true, false);
	await session(closedOnly, DAY, 'morning');
	await worker(added, true, true);

	await session(full, DAY, 'morning');
	await session(full, DAY, 'evening');
	await worker(full, true, true);
	await worker(full, true, true);
	await worker(full, true, false);
	await worker(full, false, true);
	await session(failedOnly, DAY, 'morning', 'failed');
	await session(startOnly, DAY, 'morning');
	await worker(startOnly, true, false);
	await session(other, DAY, 'morning');
	await session(other, DAY, 'evening');
	await worker(other, true, true);

	const pm1 = await manager('pmone');
	const pm2 = await manager('pmtwo', { disabled: true });
	await db.query('INSERT INTO plant_manager_assignments (plant_id, manager_id) VALUES ($1, $2)', [
		a.plantId,
		pm1.id
	]);
	await db.query('INSERT INTO plant_manager_assignments (plant_id, manager_id) VALUES ($1, $2)', [
		p2[0].id,
		pm2.id
	]);
	const mon = await manager('monitor', { monitor: true });
	await db.query('INSERT INTO monitor_areas (manager_id, area_id) VALUES ($1, $2)', [
		mon.id,
		a.areaId
	]);
	const adminId = await admin();
	const { rows: ad } = await db.query('SELECT email FROM admins WHERE id = $1', [adminId]);
	return {
		names: {
			a: await areaName(a.areaId),
			b: await areaName(b.areaId),
			c: await areaName(c.areaId),
			d: await areaName(d.areaId),
			e: await areaName(e.areaId)
		},
		codes: {
			full: await code(full),
			failedOnly: await code(failedOnly),
			silent: await code(silent),
			startOnly: await code(startOnly),
			other: await code(other),
			noPhoto: await code(noPhoto),
			unset: await code(unset)
		},
		pm1,
		pm2,
		mon,
		adminEmail: ad[0].email as string
	};
}

let world: Awaited<ReturnType<typeof build>>;
before(async () => {
	await db.connect();
	world = await build();
});
after(() => db.end());
beforeEach(async () => {
	sent = [];
	await db.query('DELETE FROM attendance_digest_log');
	await db.query(
		`INSERT INTO app_settings (key, value) VALUES ('digest_cc', 'Boss@Unit.test, cc.two@unit.test')
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
	);
	await db.query("DELETE FROM app_settings WHERE key = 'digest_first_day'");
});

const pumpsIn = (message: Sent) =>
	message.areas.flatMap((a) => a.plants.flatMap((p: any) => p.pumps));
const mailFor = (name: string) => sent.filter((m) => m.area === name);

describe('the 9 am attendance tracker', () => {
	test('nothing goes out before 9 am IST', async () => {
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0830, send);
		assert.equal(sent.length, 0);
	});

	test('no email about a day before the first day; the first day itself is sent', async () => {
		await db.query(
			"INSERT INTO app_settings (key, value) VALUES ('digest_first_day', '2026-10-01')"
		);
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		assert.equal(sent.length, 0);
		await db.query("UPDATE app_settings SET value = $1 WHERE key = 'digest_first_day'", [DAY]);
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		assert.ok(sent.length >= 2);
	});

	test('one email per Area with an Active or Idle pump, photo or not; none when all are Inactive', async () => {
		const { codes, names } = world;
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		assert.equal(mailFor(names.a).length, 1);
		assert.equal(mailFor(names.b).length, 1);
		const [c] = mailFor(names.c);
		assert.deepEqual(
			pumpsIn(c).map((p: any) => [p.pump_code, p.workers]),
			[[codes.noPhoto, 0]]
		);
		assert.equal(mailFor(names.d).length, 0);
		assert.equal(mailFor(names.e).length, 0, 'an Area not ticked at /admin/settings gets no email');
	});

	test('the Area email lists Active and Idle pumps with the three counts, Inactive left out', async () => {
		const { codes, names } = world;
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		const [mail] = mailFor(names.a);
		assert.equal(mail.day, DAY);
		const pumps = pumpsIn(mail);
		assert.deepEqual(
			pumps.map((p: any) => p.pump_code).sort(),
			[codes.full, codes.failedOnly, codes.silent, codes.startOnly].sort(),
			'the Inactive pump and the pump added after the day are not listed; a pump closed after the day is'
		);
		const full = pumps.find((p: any) => p.pump_code === codes.full);
		assert.deepEqual([full.full_shift, full.start_only, full.end_only, full.workers], [2, 1, 1, 4]);
		assert.equal(full.site_name, 'Lodha Palava');
		assert.equal(pumps.find((p: any) => p.pump_code === codes.silent).site_name, null);
		for (const code of [codes.failedOnly, codes.silent])
			assert.equal(pumps.find((p: any) => p.pump_code === code).workers, 0);
		assert.deepEqual(mail.totals, {
			pumps: 4,
			full_shift: 2,
			start_only: 2,
			end_only: 1,
			workers: 5
		});
	});

	test("To: the admins and the Area's monitors; CC: exactly the admin's list, no plant managers", async () => {
		const { names, mon, pm1, adminEmail } = world;
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		const [a] = mailFor(names.a);
		assert.ok(a.to.includes(mon.email));
		assert.ok(a.to.includes(adminEmail));
		assert.deepEqual(a.cc, ['boss@unit.test', 'cc.two@unit.test']);
		assert.ok(!a.cc.includes(pm1.email), 'a plant manager is copied only when on the list');
		const [b] = mailFor(names.b);
		assert.ok(!b.to.includes(mon.email), 'the monitor gets only their own Area');
	});

	test('no CC list, no CC; an address in To is not repeated in CC', async () => {
		await db.query("DELETE FROM app_settings WHERE key = 'digest_cc'");
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		assert.deepEqual(mailFor(world.names.b)[0].cc, []);

		await db.query('DELETE FROM attendance_digest_log');
		sent = [];
		await db.query("INSERT INTO app_settings (key, value) VALUES ('digest_cc', $1)", [
			`${world.mon.email}, cec@rdc.in`
		]);
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		assert.deepEqual(mailFor(world.names.a)[0].cc, ['cec@rdc.in']);
	});

	test('a pump never set Active or Idle is Inactive and not listed', async () => {
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		assert.ok(
			!pumpsIn(mailFor(world.names.a)[0]).some((p: any) => p.pump_code === world.codes.unset)
		);
	});

	test('once per Area per day, and logged instead of sent in test mode', async () => {
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		const first = sent.length;
		assert.ok(first >= 2);
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		assert.equal(sent.length, first);

		await db.query('DELETE FROM attendance_digest_log');
		sent = [];
		const logged: string[] = [];
		await sendAttendanceDigests(
			db,
			(_level: string, _fields: object, message: string) => logged.push(message),
			async () => true,
			AT_0930,
			send
		);
		assert.equal(sent.length, 0);
		assert.ok(logged.includes('attendance digest email NOT sent (test mode)'));
	});

	test('the subject names the Area, the day and the three counts', async () => {
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		const { subject, html } = renderAttendanceDigest(mailFor(world.names.a)[0]);
		assert.equal(
			subject.replace('Sept', 'Sep'),
			`${world.names.a} attendance, Wed, 30 Sep 2026: 2 full shift, 2 start only, 1 end only`
		);
		assert.match(html, /No end photo/);
		assert.match(html, /2 pumps with no attendance/);
		assert.equal(html.match(/background:#fdecea/g)?.length, 2, 'the two zero pumps are red rows');
		assert.match(html, /Hello,/);
		assert.match(
			html,
			/<br><span style="font-size:12px">Lodha Palava<\/span>/,
			'the site under the pump'
		);
	});
});
