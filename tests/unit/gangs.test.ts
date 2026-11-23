// Unit tests for pump gangs (worker/gangs.js, migration 056): which gang a photo is (pickGang),
// the gang headcount rule every report shares (gangDaySql), how many gangs a pump runs on a day
// (gangsForDay) and the 9 am email's gang line (gangLine in worker/digestEmail.js).
// Run: npm run test:unit (scripts/run-unit.mjs).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { gangDaySql, gangsForDay, pickGang, sameDayFraudOn } from '../../worker/gangs.js';
import { gangLine } from '../../worker/digestEmail.js';
import { area, db, face, person, pump, seen, session, TODAY, YESTERDAY } from './fixtures';

before(() => db.connect());
after(() => db.end());

async function gangsArea() {
	const a = await area();
	await db.query('UPDATE areas SET gangs_enabled = true WHERE id = $1', [a.areaId]);
	return a;
}

async function gang(areaId: string, code: number) {
	const { rows } = await db.query(
		'INSERT INTO gangs (area_id, code) VALUES ($1, $2) RETURNING id',
		[areaId, code]
	);
	return rows[0].id as string;
}

async function tag(sessionId: string, gangId: string, slot = 1) {
	await db.query('UPDATE attendance_sessions SET gang_id = $2, gang_slot = $3 WHERE id = $1', [
		sessionId,
		gangId,
		slot
	]);
}

// The same human at two pumps: two person rows linked by one area worker.
async function link(areaId: string, ...personIds: string[]) {
	const { rows } = await db.query('INSERT INTO area_workers (area_id) VALUES ($1) RETURNING id', [
		areaId
	]);
	await db.query('UPDATE persons SET area_worker_id = $1 WHERE id = ANY($2::uuid[])', [
		rows[0].id,
		personIds
	]);
}

async function headcount(areaId: string, from = TODAY, to = TODAY) {
	const { rows } = await db.query(gangDaySql('a.id = $1', 2), [areaId, from, to]);
	return rows as {
		gang_id: string;
		pump_id: string;
		session_date: string;
		people: number;
		worker_ids: string[];
		held: string | null;
	}[];
}

describe('pickGang', () => {
	const members = new Map([
		['g1', new Set(['a', 'b', 'c', 'd'])],
		['g2', new Set(['e', 'f'])]
	]);
	test('a crew is the gang holding more than half of its workers', () => {
		assert.deepEqual(pickGang(['a', 'b', 'x'], members)?.gangId, 'g1');
		assert.deepEqual(pickGang(['e', 'f', 'a'], members)?.gangId, 'g2');
	});
	test('half or less is a new gang, and an empty photo is none', () => {
		assert.equal(pickGang(['a', 'x'], members), null);
		assert.equal(pickGang(['a', 'e', 'x', 'y'], members), null);
		assert.equal(pickGang([], members), null);
	});
});

describe('gangDaySql (the headcount rule)', () => {
	test('a pump with one gang gives every worker counted that day to that gang', async () => {
		const { areaId, plantId } = await gangsArea();
		const p = await pump(plantId);
		const start = await session(p, TODAY);
		const g = await gang(areaId, 1);
		await tag(start, g);
		const people = [await person(p), await person(p), await person(p)];
		for (const id of people) await seen(id, start, face({ 0: 1 }));
		// A hand-added worker (no face that day) still counts, as on the pump sheet.
		const added = await person(p);
		await db.query(
			`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched)
			 VALUES ($1, $2, $3, true)`,
			[added, p, TODAY]
		);
		const rows = await headcount(areaId);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].gang_id, g);
		assert.equal(rows[0].people, 4);
		assert.equal(rows[0].held, null);
	});

	test('two gangs at one pump: each worker goes to the gang whose photo has their face', async () => {
		const { areaId, plantId } = await gangsArea();
		const p = await pump(plantId);
		const startA = await session(p, TODAY);
		const g1 = await gang(areaId, 1);
		const g2 = await gang(areaId, 2);
		await tag(startA, g1, 1);
		const { rows: b } = await db.query(
			`INSERT INTO attendance_sessions (pump_id, session_date, session_type, status, photo_hash, gang_id, gang_slot, submitted_at)
			 VALUES ($1, $2, 'morning', 'completed', gen_random_uuid()::text, $3, 2, now() + interval '1 minute') RETURNING id`,
			[p, TODAY, g2]
		);
		for (let i = 0; i < 3; i++) await seen(await person(p), startA, face({ 1: 1 }));
		for (let i = 0; i < 2; i++) await seen(await person(p), b[0].id, face({ 2: 1 }));
		const rows = await headcount(areaId);
		const by = Object.fromEntries(rows.map((r) => [r.gang_id, r.people]));
		assert.deepEqual(by, { [g1]: 3, [g2]: 2 });
	});

	test('a gang that moved pumps the same day counts each worker once', async () => {
		const { areaId, plantId } = await gangsArea();
		const p1 = await pump(plantId);
		const p2 = await pump(plantId);
		const g = await gang(areaId, 1);
		const s1 = await session(p1, TODAY);
		const s2 = await session(p2, TODAY);
		await tag(s1, g);
		await tag(s2, g);
		for (let i = 0; i < 3; i++) {
			const at1 = await person(p1);
			const at2 = await person(p2);
			await seen(at1, s1, face({ 3: 1 }));
			await seen(at2, s2, face({ 3: 1 }));
			await link(areaId, at1, at2);
		}
		const rows = await headcount(areaId);
		assert.equal(rows.length, 2, 'one row per pump');
		assert.deepEqual(
			rows.map((r) => r.people),
			[3, 3]
		);
		const once = new Set(rows.flatMap((r) => r.worker_ids));
		assert.equal(once.size, 3, 'the day counts 3 workers, not 6');
	});

	test('a shift start waiting for its location approval marks the day held; an end never does', async () => {
		const { areaId, plantId } = await gangsArea();
		const p = await pump(plantId);
		const g = await gang(areaId, 1);
		const start = await session(p, YESTERDAY);
		const end = await session(p, YESTERDAY, 'evening');
		await tag(start, g);
		await tag(end, g);
		await seen(await person(p), start, face({ 4: 1 }));
		// An end with a location status (old rows) is ignored: only starts are checked.
		await db.query(`UPDATE attendance_sessions SET location_status = 'pending' WHERE id = $1`, [
			end
		]);
		assert.equal((await headcount(areaId, YESTERDAY, YESTERDAY))[0].held, null);
		await db.query(`UPDATE attendance_sessions SET location_status = 'pending' WHERE id = $1`, [
			start
		]);
		assert.equal((await headcount(areaId, YESTERDAY, YESTERDAY))[0].held, 'pending');
		await db.query(`UPDATE attendance_sessions SET location_status = 'approved' WHERE id = $1`, [
			start
		]);
		assert.equal((await headcount(areaId, YESTERDAY, YESTERDAY))[0].held, null);
	});

	test('an Area with gangs off has no gang rows', async () => {
		const { areaId, plantId } = await area();
		const p = await pump(plantId);
		const s = await session(p, TODAY);
		await tag(s, await gang(areaId, 1));
		await seen(await person(p), s, face({ 5: 1 }));
		assert.deepEqual(await headcount(areaId), []);
	});
});

describe('gangsForDay and the fraud switch', () => {
	test('2 gangs only on the day it was set, and only in an Area with gangs on', async () => {
		const on = await gangsArea();
		const off = await area();
		const pOn = await pump(on.plantId);
		const pOff = await pump(off.plantId);
		for (const p of [pOn, pOff])
			await db.query(
				`INSERT INTO pump_day_status (pump_id, day, status, gangs, set_by_role, set_by_id, set_by_name)
				 VALUES ($1, $2, 'active', 2, 'admin', gen_random_uuid(), 'Unit')`,
				[p, TODAY]
			);
		assert.equal(await gangsForDay(db, pOn, TODAY), 2);
		assert.equal(await gangsForDay(db, pOn, '2026-10-24'), 1, 'the next day is back to 1');
		assert.equal(await gangsForDay(db, pOff, TODAY), 1, 'gangs off: always 1');
	});

	test('the same-day fraud check is off unless the setting says on', async () => {
		await db.query(`DELETE FROM app_settings WHERE key = 'same_day_fraud_check'`);
		assert.equal(await sameDayFraudOn(db), false);
		await db.query(`INSERT INTO app_settings (key, value) VALUES ('same_day_fraud_check', 'on')`);
		assert.equal(await sameDayFraudOn(db), true);
		await db.query(`DELETE FROM app_settings WHERE key = 'same_day_fraud_check'`);
	});
});

describe('gangLine (9 am email)', () => {
	test('headcount, other pumps that day and a held start, escaped', () => {
		const html = gangLine([
			{ code: 3, name: null, people: 7, held: null, also: ['BGPUMP07'] },
			{ code: 5, name: '<Raju>', people: 1, held: 'pending', also: [] }
		]);
		assert.match(html, /Gang 3, 7 people, also at BGPUMP07 that day\./);
		assert.match(html, /Gang 5 \(&lt;Raju&gt;\), 1 person/);
		assert.match(html, /shift start away from the pump: waiting for approval/);
		assert.doesNotMatch(html, /<Raju>/);
	});
});
