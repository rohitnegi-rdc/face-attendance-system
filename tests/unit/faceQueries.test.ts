// Unit tests for the worker's face lookups (worker/faceQueries.js) and the two app paths that
// must treat new workers the same way: "Not fraud" (fraudResolution.ts) and session delete /
// pump Retry (sessionCleanup.ts). Run: npm run test:unit (scripts/run-unit.mjs).
//
// Face vectors are built from axes (fixtures.face), so every similarity below is exact:
//   SHARP    = axis 0                      the worker's good photo
//   WORSE    = 0.4 axis 0 + 0.917 axis 1    same worker, worse photo (0.40 to SHARP)
//   STRANGER = 0.3 axis 0 + 0.954 axis 2    0.30 to SHARP (above 0.28), 0.12 to WORSE
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PoolClient } from 'pg';
import {
	assignFaces,
	findCrossPumpMatch,
	findLocalCandidates,
	findLocalMatch,
	keepsInGallery
} from '../../worker/faceQueries.js';
import { markNotFraud } from '../../src/lib/server/fraudResolution';
import { deleteSession } from '../../src/lib/server/sessionCleanup';
import {
	TODAY,
	YESTERDAY,
	admin,
	area,
	db,
	exists,
	face,
	person,
	pump,
	seen,
	session
} from './fixtures';

const SHARP = face({ 0: 1 });
const WORSE = face({ 0: 0.4, 1: 0.917 });
const STRANGER = face({ 0: 0.3, 2: 0.954 });
const OTHER = face({ 3: 1 });
const client = db as unknown as PoolClient;

before(() => db.connect());
after(() => db.end());

describe('findCrossPumpMatch', () => {
	test("compares today's faces at the other pump, never older gallery faces", async () => {
		const { areaId, plantId } = await area();
		const [a, b] = [await pump(plantId), await pump(plantId)];
		const worker = await person(b);
		await seen(worker, await session(b, YESTERDAY), SHARP);
		const today = await session(b, TODAY);
		await seen(worker, today, WORSE);

		const match = await findCrossPumpMatch(db, {
			vector: STRANGER,
			sessionDate: TODAY,
			areaId,
			pumpId: a
		});
		// Against yesterday's SHARP face this stranger would score 0.30 and be flagged.
		assert.equal(match.person_id, worker);
		assert.ok(Math.abs(match.similarity - 0.12) < 0.01, `similarity ${match.similarity}`);
		assert.equal(match.matched_session_id, today);
	});

	test('names the session the matching face came from', async () => {
		const { areaId, plantId } = await area();
		const [a, b] = [await pump(plantId), await pump(plantId)];
		const worker = await person(b);
		await seen(worker, await session(b, TODAY, 'morning'), OTHER);
		const evening = await session(b, TODAY, 'evening');
		await seen(worker, evening, SHARP);

		const match = await findCrossPumpMatch(db, {
			vector: SHARP,
			sessionDate: TODAY,
			areaId,
			pumpId: a
		});
		assert.equal(match.matched_session_id, evening);
		assert.ok(match.similarity > 0.99);
	});

	test('a worker seen at the other pump only on an earlier day is not compared', async () => {
		const { areaId, plantId } = await area();
		const [a, b] = [await pump(plantId), await pump(plantId)];
		const worker = await person(b);
		await seen(worker, await session(b, YESTERDAY), SHARP);

		const match = await findCrossPumpMatch(db, {
			vector: SHARP,
			sessionDate: TODAY,
			areaId,
			pumpId: a
		});
		assert.equal(match, undefined);
	});

	test('includes a new worker (pending_review) in a session still in review', async () => {
		const { areaId, plantId } = await area();
		const [a, b] = [await pump(plantId), await pump(plantId)];
		const worker = await person(b, 'pending_review');
		await seen(worker, await session(b, TODAY, 'morning', 'review'), SHARP);

		const match = await findCrossPumpMatch(db, {
			vector: SHARP,
			sessionDate: TODAY,
			areaId,
			pumpId: a
		});
		assert.equal(match?.person_id, worker);
	});

	test("ignores the pump's own workers and other Areas", async () => {
		const { areaId, plantId } = await area();
		const a = await pump(plantId);
		const own = await person(a);
		await seen(own, await session(a, TODAY), SHARP);
		const elsewhere = await area();
		const c = await pump(elsewhere.plantId);
		const far = await person(c);
		await seen(far, await session(c, TODAY), SHARP);

		const match = await findCrossPumpMatch(db, {
			vector: SHARP,
			sessionDate: TODAY,
			areaId,
			pumpId: a
		});
		assert.equal(match, undefined);
	});
});

describe('findLocalMatch', () => {
	test("matches a new worker (pending_review) from the pump's uncompleted shift end", async () => {
		const { plantId } = await area();
		const a = await pump(plantId);
		const worker = await person(a, 'pending_review');
		await seen(worker, await session(a, YESTERDAY, 'evening', 'review'), SHARP);

		const match = await findLocalMatch(db, { vector: SHARP, pumpId: a });
		assert.equal(match?.person_id, worker);
	});

	test('still uses the whole gallery, older days included', async () => {
		const { plantId } = await area();
		const a = await pump(plantId);
		const worker = await person(a);
		await seen(worker, await session(a, YESTERDAY), SHARP);

		const match = await findLocalMatch(db, { vector: SHARP, pumpId: a });
		assert.equal(match?.person_id, worker);
	});

	test('findLocalCandidates lists the closest people, best first', async () => {
		const { plantId } = await area();
		const a = await pump(plantId);
		const s = await session(a, TODAY);
		const [near, far, farthest] = [await person(a), await person(a), await person(a)];
		await seen(near, s, SHARP);
		await seen(far, s, WORSE);
		await seen(farthest, s, OTHER);

		const list = await findLocalCandidates(db, { vector: SHARP, pumpId: a, limit: 2 });
		assert.deepEqual(
			list.map((c) => c.person_id),
			[near, far]
		);
	});

	test('ignores merged workers and other pumps', async () => {
		const { plantId } = await area();
		const [a, b] = [await pump(plantId), await pump(plantId)];
		const merged = await person(a, 'merged');
		await seen(merged, await session(a, TODAY), SHARP);
		const other = await person(b);
		await seen(other, await session(b, TODAY), SHARP);

		const match = await findLocalMatch(db, { vector: SHARP, pumpId: a });
		assert.equal(match, undefined);
	});
});

describe('assignFaces', () => {
	const T = 0.28;

	test('two faces never take the same worker; the stronger face keeps them', () => {
		// Face 0 (listed first by the AI) is the weaker match for Ramesh.
		const result = assignFaces(
			[[{ person_id: 'ramesh', similarity: 0.35 }], [{ person_id: 'ramesh', similarity: 0.62 }]],
			T
		);
		assert.equal(result[1]?.person_id, 'ramesh');
		assert.equal(result[0], null, 'the other face becomes a new worker');
	});

	test('a face whose best worker is taken falls back to its next-best one', () => {
		const result = assignFaces(
			[
				[
					{ person_id: 'ramesh', similarity: 0.5 },
					{ person_id: 'suresh', similarity: 0.45 }
				],
				[{ person_id: 'ramesh', similarity: 0.7 }]
			],
			T
		);
		assert.deepEqual(result[0], {
			person_id: 'suresh',
			similarity: 0.45,
			runner_up_similarity: 0.5
		});
		assert.equal(result[1]?.person_id, 'ramesh');
	});

	test('the fallback face stays out of the gallery; a clear winner joins it', () => {
		const result = assignFaces(
			[
				[
					{ person_id: 'ramesh', similarity: 0.5 },
					{ person_id: 'suresh', similarity: 0.45 }
				],
				[
					{ person_id: 'ramesh', similarity: 0.7 },
					{ person_id: 'suresh', similarity: 0.1 }
				]
			],
			T
		);
		const rules = { addThreshold: 0.4, margin: 0.1 };
		assert.equal(keepsInGallery(result[0]!, rules), false);
		assert.equal(keepsInGallery(result[1]!, rules), true);
	});

	test('below the threshold is no match, and distinct workers are untouched', () => {
		const result = assignFaces(
			[
				[{ person_id: 'ramesh', similarity: 0.9 }],
				[{ person_id: 'suresh', similarity: 0.8 }],
				[{ person_id: 'ramesh', similarity: 0.2 }],
				[]
			],
			T
		);
		assert.deepEqual(
			result.map((r) => r?.person_id ?? null),
			['ramesh', 'suresh', null, null]
		);
	});
});

describe('markNotFraud', () => {
	test("gives the face to the pump's new worker (pending_review), not a second new worker", async () => {
		const { plantId } = await area();
		const [a, b] = [await pump(plantId), await pump(plantId)];
		const worker = await person(b, 'pending_review');
		await seen(worker, await session(b, TODAY, 'morning', 'review'), SHARP);
		const flagged = await session(b, TODAY, 'evening', 'review');
		const elsewhere = await person(a);
		const sessionA = await session(a, TODAY);
		await seen(elsewhere, sessionA, SHARP);
		const { rows } = await db.query(
			`INSERT INTO fraud_flags (session_id, person_id, matched_at_pump_id, matched_session_id,
			                          similarity_score, face_embedding)
			 VALUES ($1, $2, $3, $4, 0.9, $5::vector) RETURNING id`,
			[flagged, elsewhere, a, sessionA, SHARP]
		);

		const result = await markNotFraud(client, rows[0].id, await admin());
		assert.deepEqual(result, { personId: worker, createdPerson: false });
	});
});

describe('deleteSession', () => {
	test("retrying today's start keeps the new worker an earlier uncompleted end found", async () => {
		const { plantId } = await area();
		const a = await pump(plantId);
		const worker = await person(a, 'pending_review');
		const yesterdayEnd = await session(a, YESTERDAY, 'evening', 'review');
		await seen(worker, yesterdayEnd, SHARP);
		const todayStart = await session(a, TODAY, 'morning', 'review');
		await seen(worker, todayStart, SHARP);
		const onlyToday = await person(a, 'pending_review');
		await seen(onlyToday, todayStart, OTHER);

		const result = await deleteSession(client, todayStart, { cascadePairedEvening: false });
		assert.deepEqual(result.personIds, [onlyToday]);
		assert.ok(await exists('persons', worker), "yesterday's worker was deleted");
		assert.equal(await exists('persons', onlyToday), false);
		const { rows } = await db.query(
			`SELECT session_date::text AS date, morning_matched, evening_matched
			 FROM daily_person_attendance WHERE person_id = $1`,
			[worker]
		);
		assert.deepEqual(rows, [{ date: YESTERDAY, morning_matched: false, evening_matched: true }]);

		// Deleting yesterday's end too leaves nothing of the worker.
		const again = await deleteSession(client, yesterdayEnd, { cascadePairedEvening: false });
		assert.deepEqual(again.personIds, [worker]);
		assert.equal(await exists('persons', worker), false);
	});
});
