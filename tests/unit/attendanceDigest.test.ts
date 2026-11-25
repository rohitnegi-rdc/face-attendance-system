// Unit tests for the 9 am attendance tracker (worker/attendanceDigest.js, renderAttendanceDigest in
// worker/digestEmail.js): one email per Area, its Active and Idle pumps (a zero in red), who gets
// it, who is copied, and the counts per pump.
// Run: npm run test:unit (scripts/run-unit.mjs).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { sendAttendanceDigests } from '../../worker/attendanceDigest.js';
import { renderAttendanceDigest } from '../../worker/digestEmail.js';
// The real mailer, loaded by path so svelte-check does not type-check the untyped worker file.
const MAILER = '../../worker/mailer.js';
const { sendAttendanceDigestEmail } = (await import(MAILER)) as {
	sendAttendanceDigestEmail: (message: unknown, log: unknown) => Promise<void>;
};
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
	mtd: any;
	locationCheck?: boolean;
	approvals?: { name: string | null; plants: string; waiting: number; oldest: string | null }[];
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
async function worker(pumpId: string, start: boolean, end: boolean, day = DAY) {
	const id = await person(pumpId);
	await db.query(
		`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched, evening_matched)
		 VALUES ($1, $2, $3, $4, $5)`,
		[id, pumpId, day, start, end]
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
	// Month to date: `full` earlier this month and last month; `silent` before it was set Idle.
	await worker(full, true, true, '2026-09-01');
	await worker(full, true, true, '2026-08-31');
	await worker(silent, true, false, '2026-09-05');
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
	await db.query(
		`INSERT INTO admins (email, password_hash) VALUES ('admin@attendance.rdc', 'x')
		 ON CONFLICT DO NOTHING`
	);
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
			marked: 2,
			full_shift: 2,
			start_only: 2,
			end_only: 1,
			workers: 5,
			mtd_workers: 7
		});
	});

	// 2026-11-18: "add plant managers and business managers in cc not TO".
	test("To: the admins and the Area's monitors; CC: the admin's list and its plant managers", async () => {
		const { names, mon, pm1, pm2, adminEmail } = world;
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		const [a] = mailFor(names.a);
		assert.ok(a.to.includes(mon.email));
		assert.ok(a.to.includes(adminEmail));
		assert.ok(!a.to.includes('admin@attendance.rdc'), 'a made-up login has no mailbox');
		assert.ok(!a.to.includes(pm1.email), 'a plant manager is copied, not in To');
		assert.deepEqual(a.cc, ['boss@unit.test', 'cc.two@unit.test', pm1.email.toLowerCase()]);
		assert.ok(!a.cc.includes(pm2.email.toLowerCase()), 'a disabled plant manager gets nothing');
		const [b] = mailFor(names.b);
		assert.ok(!b.to.includes(mon.email), 'the monitor gets only their own Area');
		assert.ok(!b.cc.includes(pm1.email.toLowerCase()), 'a plant manager only for their plants');
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
		assert.deepEqual(mailFor(world.names.a)[0].cc, ['cec@rdc.in', world.pm1.email.toLowerCase()]);
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

	test("MTD is the pump's total attendance from the 1st till that day, whatever its status", async () => {
		const { codes, names } = world;
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		const [a] = mailFor(names.a);
		const pumps = pumpsIn(a);
		const mtdOf = (pumpCode: string) =>
			pumps.find((p: any) => p.pump_code === pumpCode).mtd_workers;
		assert.equal(mtdOf(codes.full), 5, '4 on the day and 1 on the 1st, not the one in August');
		assert.equal(mtdOf(codes.silent), 1, 'before it was set Idle; still no one on the day');
		assert.equal(mtdOf(codes.startOnly), 1);
		assert.equal(mtdOf(codes.failedOnly), 0);
		assert.equal(a.totals.mtd_workers, 7);
		// Marked days are Active or Idle ones: `full` on the 1st and DAY, `startOnly` on DAY.
		assert.equal(a.mtd.marked, 3);
		// Area C: one Active pump on all 30 days of September, no photo on any of them.
		assert.deepEqual(mailFor(names.c)[0].mtd, { pump_days: 30, marked: 0 });
	});

	test('the summary shows pumps, marked and month to date; plants are a column of one table', async () => {
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		const mail = mailFor(world.names.a)[0];
		const { html } = renderAttendanceDigest(mail);
		assert.match(html, /Total pumps<\/th><th [^>]*>Marked attendance<\/th><\/tr>/);
		assert.match(
			html,
			/2026<\/td><td [^>]*><strong>4<\/strong><\/td><td [^>]*><strong>2<\/strong>/
		);
		assert.match(html, /Month to date<\/td>/);
		assert.match(html, /<th [^>]*>Plant<\/th>/);
		assert.match(html, /<th [^>]*>MTD<\/th>/);
		assert.equal(html.match(/<table/g)?.length, 2, 'the summary and one pump table');
		for (const plant of mail.areas[0].plants) assert.ok(html.includes(`>${plant.name}</td>`));
		assert.equal(
			html.match(/<td colspan="9"[^>]*>&nbsp;<\/td>/g)?.length ?? 0,
			mail.areas[0].plants.length - 1,
			'one empty row between plants'
		);
	});

	test('the subject names the Area, the day and the three counts', async () => {
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		const { subject, html } = renderAttendanceDigest(mailFor(world.names.a)[0]);
		assert.equal(
			subject.replace('Sept', 'Sep'),
			`${world.names.a} attendance, Wed, 30 Sep 2026: 2 full shift, 2 start only, 1 end only`
		);
		assert.match(html, /No end photo/);
		// The Idle pump with nobody has no work that day: a plain row, not red (2026-11-25).
		assert.match(html, /1 pump with no attendance/);
		assert.equal(html.match(/background:#fdecea/g)?.length, 1, 'only the Active zero pump is red');
		assert.match(html, /Idle, no work/);
		assert.match(html, /Hello,/);
		assert.match(
			html,
			/<br><span style="font-size:12px">Lodha Palava<\/span>/,
			'the site under the pump'
		);
	});
});

// Area F (2026-11-17): the business managers of its plants get the email, the business heads of
// its plants are copied (business_head_plants, from the mapping BHBMPLANTSMAPPING.MD), and each pump with a missed day request for the day shows the reason and where it stands.
describe('business managers, business heads and missed day requests', () => {
	let f: {
		name: string;
		bm: { id: string; email: string };
		gone: { id: string; email: string };
		pm: { id: string; email: string };
		codes: { waiting: string; approved: string; rejected: string; none: string };
	};

	async function businessManager(name: string, disabled = false) {
		const { rows } = await db.query(
			`INSERT INTO plant_managers (name, email, password_hash, is_business_manager, disabled_at)
			 VALUES ($1, $2, 'x', true, $3) RETURNING id, email`,
			[name, `${name}.${randomUUID().slice(0, 8)}@Unit.test`, disabled ? new Date() : null]
		);
		return { id: rows[0].id as string, email: (rows[0].email as string).toLowerCase() };
	}

	// A business head login (Google sign-in, no password) given one plant.
	async function businessHead(email: string, plantId: string, disabled = false) {
		const { rows } = await db.query(
			`INSERT INTO plant_managers (name, email, password_hash, is_business_head, disabled_at)
			 VALUES ($1, $2, NULL, true, $3) RETURNING id`,
			[email.split('@')[0], email, disabled ? new Date() : null]
		);
		await db.query('INSERT INTO business_head_plants (plant_id, manager_id) VALUES ($1, $2)', [
			plantId,
			rows[0].id
		]);
	}

	async function request(
		pumpId: string,
		status: string,
		extra: { note?: string; voice?: boolean; by?: string; why?: string } = {}
	) {
		await db.query(
			`INSERT INTO regularisations (pump_id, day, reason, note, voice_path, requested_by_role,
			   requested_by_id, requested_by_name, status, decided_by_role, decided_by_name,
			   decision_reason, link_base)
			 VALUES ($1, $2, 'phone_problem', $3, $4, 'pump', $1, 'Pump', $5, $6, $7, $8, 'http://x')`,
			[
				pumpId,
				DAY,
				extra.note ?? null,
				extra.voice ? 'regularisations/x.webm' : null,
				status,
				extra.by ? 'business_manager' : null,
				extra.by ?? null,
				extra.why ?? null
			]
		);
	}

	before(async () => {
		const a = await area();
		const { rows: p2 } = await db.query(
			"INSERT INTO plants (area_id, name) VALUES ($1, 'BMPLANT-' || substr(md5(random()::text), 1, 8)) RETURNING id",
			[a.areaId]
		);
		await db.query('UPDATE areas SET digest_enabled = true WHERE id = $1', [a.areaId]);
		const waiting = await pump(a.plantId);
		const approved = await pump(a.plantId);
		const rejected = await pump(p2[0].id);
		const none = await pump(p2[0].id);
		const ids = [waiting, approved, rejected, none];
		await db.query("UPDATE pumps SET created_at = '2026-09-01' WHERE id = ANY($1)", [ids]);
		for (const id of ids)
			await db.query(
				`INSERT INTO pump_day_status (pump_id, day, status, set_by_role, set_by_id, set_by_name)
				 VALUES ($1, '2026-09-01', 'active', 'admin', gen_random_uuid(), 'unit')`,
				[id]
			);
		const bm = await businessManager('asha');
		const gone = await businessManager('left', true);
		await db.query(
			'INSERT INTO business_manager_plants (plant_id, manager_id) VALUES ($1, $2), ($3, $4)',
			[a.plantId, bm.id, p2[0].id, gone.id]
		);
		// One head per plant; boss@ is also on the fixed CC list, a removed head gets nothing.
		const { rows: p3 } = await db.query(
			"INSERT INTO plants (area_id, name) VALUES ($1, 'BHPLANT-' || substr(md5(random()::text), 1, 8)) RETURNING id",
			[a.areaId]
		);
		await businessHead('Head@unit.test', a.plantId);
		await businessHead('boss@unit.test', p2[0].id);
		await businessHead('gone.head@unit.test', p3[0].id, true);
		// The Area's own CC (migration 053); cc.two@ is also on the global list.
		await db.query(
			`INSERT INTO area_digest_cc (area_id, email) VALUES ($1, 'area.only@unit.test'),
			   ($1, 'cc.two@unit.test')`,
			[a.areaId]
		);
		await request(waiting, 'pending', { note: 'Phone fell in water', voice: true });
		await request(approved, 'approved', { by: 'Asha' });
		await worker(approved, true, true);
		await db.query(
			`UPDATE daily_person_attendance SET regularisation_id =
			   (SELECT id FROM regularisations WHERE pump_id = $1) WHERE pump_id = $1`,
			[approved]
		);
		await request(rejected, 'rejected', { by: 'Asha', why: 'The workers listed are not right' });
		// A cancelled request is not news.
		await request(none, 'cancelled');
		const pm = await manager('plantmgr');
		await db.query('INSERT INTO plant_manager_assignments (plant_id, manager_id) VALUES ($1, $2)', [
			p2[0].id,
			pm.id
		]);
		f = {
			name: await areaName(a.areaId),
			bm,
			gone,
			pm,
			codes: {
				waiting: await code(waiting),
				approved: await code(approved),
				rejected: await code(rejected),
				none: await code(none)
			}
		};
	});

	test('CC: its own CC, business heads, business managers and plant managers, never twice', async () => {
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		const [mail] = mailFor(f.name);
		assert.ok(!mail.to.includes(f.bm.email), 'a business manager is copied, not in To');
		assert.ok(!mail.to.includes(f.pm.email), 'a plant manager is copied, not in To');
		assert.deepEqual(mail.cc, [
			'boss@unit.test',
			'cc.two@unit.test',
			'area.only@unit.test',
			'head@unit.test',
			f.bm.email.toLowerCase(),
			f.pm.email.toLowerCase()
		]);
		assert.ok(
			!mail.cc.includes(f.gone.email.toLowerCase()),
			'a removed business manager gets nothing'
		);
		const [other] = mailFor(world.names.a);
		assert.ok(!other.cc.includes(f.bm.email.toLowerCase()), 'only the Area of their plants');
		assert.ok(!other.cc.includes('area.only@unit.test'), "an area CC only on that Area's email");
		assert.ok(!other.cc.includes('head@unit.test'), "a business head only for their plants' Area");
	});

	type LogFields = { area?: string; day?: string; to: string[]; cc: string[] };
	type LogLine = { fields: LogFields; message: string };

	// 2026-11-18: "Still the plant manager, BM, BH is not there in the daily email for that area ...
	// test with logs that mail is sending but don't send actual mails". The real mailer, mail off:
	// nothing is sent and the log line names every address it would go to.
	test('with mail off the real mailer sends nothing and logs plant manager, BM and BH', async () => {
		const before = process.env.MAIL_ENABLED;
		delete process.env.MAIL_ENABLED;
		const lines: LogLine[] = [];
		const capture = (_level: string, fields: object, message: string) => {
			lines.push({ fields: fields as LogFields, message });
		};
		try {
			await sendAttendanceDigests(db, capture, testModeOff, AT_0930, sendAttendanceDigestEmail);
		} finally {
			if (before === undefined) delete process.env.MAIL_ENABLED;
			else process.env.MAIL_ENABLED = before;
		}
		const line = lines.find((l) => l.fields.area === f.name);
		assert.ok(line, 'one log line for the Area');
		assert.equal(line.message, 'attendance digest email NOT sent (mail off)');
		assert.equal(line.fields.day, DAY);
		assert.ok(line.fields.cc.includes(f.pm.email.toLowerCase()), 'the plant manager is in CC');
		assert.ok(line.fields.cc.includes(f.bm.email.toLowerCase()), 'the business manager is in CC');
		assert.ok(line.fields.cc.includes('head@unit.test'), 'the business head is in CC');
		assert.ok(line.fields.cc.includes('area.only@unit.test'), "the Area's own CC is in CC");
		assert.ok(!line.fields.to.includes(f.gone.email));
		assert.ok(!lines.some((l) => l.message === 'attendance digest email sent'), 'nothing sent');
	});

	test('in test mode the log names the same people and nothing is sent', async () => {
		const lines: LogLine[] = [];
		let mailed = 0;
		await sendAttendanceDigests(
			db,
			(_level, fields, message) => lines.push({ fields: fields as LogFields, message }),
			async () => true,
			AT_0930,
			async () => {
				mailed++;
			}
		);
		const line = lines.find((l) => l.fields.area === f.name);
		assert.equal(line?.message, 'attendance digest email NOT sent (test mode)');
		assert.ok(line?.fields.cc.includes(f.pm.email.toLowerCase()));
		assert.ok(line?.fields.cc.includes('head@unit.test'));
		assert.equal(mailed, 0);
	});

	test('each request shows its reason, note and where it stands', async () => {
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		const [mail] = mailFor(f.name);
		const byCode = Object.fromEntries(pumpsIn(mail).map((p) => [p.pump_code, p]));
		assert.equal(byCode[f.codes.waiting].request.status, 'pending');
		assert.equal(byCode[f.codes.waiting].request.decider, 'asha');
		assert.equal(byCode[f.codes.approved].request.status, 'approved');
		// Its business manager left, so the plant's plant manager decides (migration 055).
		assert.equal(byCode[f.codes.rejected].request.decider, 'plantmgr');
		assert.equal(byCode[f.codes.rejected].request.decider_role, 'plant manager');
		assert.equal(byCode[f.codes.none].request, null, 'a cancelled request is left out');

		const { html } = renderAttendanceDigest(mail);
		const line = (status: string) =>
			html.match(new RegExp(`data-request="${status}">(.*?)</td>`))?.[1] ?? '';
		assert.equal(
			line('pending').replace(/<[^>]+>/g, ''),
			'Missed day request: Phone dead or broken, &ldquo;Phone fell in water&rdquo;, with a voice note in the app. Waiting for approval by asha (business manager).'
		);
		assert.equal(
			line('approved').replace(/<[^>]+>/g, ''),
			'Missed day request: Phone dead or broken. Approved by Asha.'
		);
		assert.equal(
			line('rejected').replace(/<[^>]+>/g, ''),
			'Missed day request: Phone dead or broken. Rejected by Asha: The workers listed are not right.'
		);
		assert.equal(html.match(/data-request=/g)?.length, 3);
		assert.match(html, /<strong>Regularised<\/strong> \(missed day, approved\)/);
		assert.match(
			html,
			/<li><strong>Missed day request:<\/strong> the pump asked/,
			'the legend says what it is'
		);
	});

	test('a note is escaped in the email', () => {
		const { html } = renderAttendanceDigest({
			area: 'X',
			day: DAY,
			mtd: { pump_days: 1, marked: 0 },
			totals: {
				pumps: 1,
				marked: 0,
				full_shift: 0,
				start_only: 0,
				end_only: 0,
				workers: 0,
				mtd_workers: 0
			},
			areas: [
				{
					name: 'X',
					plants: [
						{
							id: 'p',
							name: 'P',
							totals: { full_shift: 0, start_only: 0, end_only: 0, workers: 0, mtd_workers: 0 },
							pumps: [
								{
									pump_code: 'PX',
									start_at: null,
									end_at: null,
									full_shift: 0,
									start_only: 0,
									end_only: 0,
									workers: 0,
									mtd_workers: 0,
									request: { status: 'pending', reason: 'other', note: '<b>hi</b>', decider: null }
								}
							]
						}
					]
				}
			]
		});
		assert.ok(html.includes('&lt;b&gt;hi&lt;/b&gt;'));
		assert.ok(html.includes('Waiting for approval</strong> by an admin.'));
	});
});

// 2026-11-18: "show in the daily tracker that approvals count pending from this plant manager as
// pump as away from the pump attendance". Area with the location check on: plant 1 (Ravi) has a
// start away from the pump waiting on DAY and an older one still waiting; plant 2 (Sunil) a start
// approved by Sunil; plant 3 has no plant manager and a start waiting.
describe('shift starts away from the pump in the 9 am tracker', () => {
	let g: {
		name: string;
		plants: string[];
		codes: { waiting: string; approved: string; orphan: string };
	};

	async function active(pumpId: string) {
		await db.query("UPDATE pumps SET created_at = '2026-09-01' WHERE id = $1", [pumpId]);
		await db.query(
			`INSERT INTO pump_day_status (pump_id, day, status, set_by_role, set_by_id, set_by_name)
			 VALUES ($1, '2026-09-01', 'active', 'admin', gen_random_uuid(), 'unit')`,
			[pumpId]
		);
	}

	async function heldStart(
		pumpId: string,
		day: string,
		status: string,
		issue: string,
		extra: { distance?: number; by?: string; note?: string } = {}
	) {
		const id = await session(pumpId, day);
		await db.query(
			`UPDATE attendance_sessions SET location_status = $2, location_issue = $3,
			   location_distance_m = $4, location_decided_by = $5, location_note = $6,
			   location_decided_at = CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END
			 WHERE id = $1`,
			[id, status, issue, extra.distance ?? null, extra.by ?? null, extra.note ?? null]
		);
	}

	before(async () => {
		const a = await area();
		await db.query(
			'UPDATE areas SET digest_enabled = true, location_check_enabled = true WHERE id = $1',
			[a.areaId]
		);
		const plant = async (prefix: string) =>
			(
				await db.query(
					`INSERT INTO plants (area_id, name) VALUES ($1, $2 || substr(md5(random()::text), 1, 6))
					 RETURNING id, name`,
					[a.areaId, prefix]
				)
			).rows[0] as { id: string; name: string };
		const p1 = (await db.query('SELECT id, name FROM plants WHERE id = $1', [a.plantId]))
			.rows[0] as { id: string; name: string };
		const p2 = await plant('LOCP2-');
		const p3 = await plant('LOCP3-');
		const ravi = await manager('Ravi');
		const sunil = await manager('Sunil');
		const left = await manager('Left', { disabled: true });
		await db.query(
			`INSERT INTO plant_manager_assignments (plant_id, manager_id) VALUES ($1, $2), ($3, $4), ($5, $6)`,
			[p1.id, ravi.id, p2.id, sunil.id, p3.id, left.id]
		);
		const waiting = await pump(p1.id);
		const older = await pump(p1.id);
		const approved = await pump(p2.id);
		const orphan = await pump(p3.id);
		for (const id of [waiting, approved, orphan]) await active(id);
		await heldStart(waiting, DAY, 'pending', 'too_far', { distance: 340 });
		await heldStart(older, '2026-09-28', 'pending', 'stale_pump_gps');
		await heldStart(approved, DAY, 'approved', 'no_phone_location', { by: sunil.id });
		await worker(approved, true, false);
		await heldStart(orphan, DAY, 'pending', 'no_pump_gps');
		g = {
			name: await areaName(a.areaId),
			plants: [p1.name, p2.name, p3.name],
			codes: {
				waiting: await code(waiting),
				approved: await code(approved),
				orphan: await code(orphan)
			}
		};
	});

	test('each plant manager has the count of starts still waiting, oldest day, no plant manager row', async () => {
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		const [mail] = mailFor(g.name);
		assert.equal(mail.locationCheck, true);
		assert.deepEqual(
			mail.approvals?.map((a) => [a.name, a.plants, a.waiting, a.oldest]),
			[
				['Ravi', g.plants[0], 2, '2026-09-28'],
				[null, g.plants[2], 1, DAY],
				['Sunil', g.plants[1], 0, null]
			],
			'waiting first; the disabled manager of plant 3 is not counted as its manager'
		);
	});

	test('each pump shows its start away from the pump: waiting for whom, or who approved', async () => {
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		const [mail] = mailFor(g.name);
		const byCode = Object.fromEntries(pumpsIn(mail).map((p: any) => [p.pump_code, p]));
		assert.deepEqual(byCode[g.codes.waiting].location, {
			status: 'pending',
			issue: 'too_far',
			distance_m: 340,
			decided_by: null,
			note: null,
			approvers: ['Ravi']
		});
		assert.equal(byCode[g.codes.approved].location.status, 'approved');
		assert.equal(byCode[g.codes.approved].location.decided_by, 'Sunil');
		assert.deepEqual(byCode[g.codes.orphan].location.approvers, []);

		const { html } = renderAttendanceDigest(mail as any);
		const text = html.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'");
		for (const sentence of [
			'Shift start away from the pump: the operator was 340 m from the pump (allowed: 100 m). Waiting for approval by Ravi (plant manager). Not counted until approved.',
			"Shift start away from the pump: the operator's phone did not share its location. Approved by Sunil.",
			"Shift start away from the pump: no GPS position had been received for the pump. Waiting for approval by the area's monitors (no plant manager). Not counted until approved."
		])
			assert.ok(text.includes(sentence), sentence);
		assert.ok(html.includes('data-approvals-total="3"'));
		assert.ok(html.includes('3 shift starts wait</strong>'));
		assert.ok(html.includes('No plant manager'));
		assert.ok(html.includes('Mon, 28 Sept 2026') || html.includes('Mon, 28 Sep 2026'));
	});

	test('an area without the location check and nothing waiting has no approvals table', async () => {
		await sendAttendanceDigests(db, quiet, testModeOff, AT_0930, send);
		const [b] = mailFor(world.names.b);
		assert.equal(b.locationCheck, false);
		assert.ok(!renderAttendanceDigest(b as any).html.includes('waiting for approval'));
	});
});
