// Unit tests for the gallery rules (worker/faceQueries.js, GALLERY): a wrong match must not feed on
// itself through the person's saved faces. Run: npm run test:unit (scripts/run-unit.mjs).
//
// Face vectors (fixtures.face), exact similarities:
//   SHARP    = axis 0                     the worker's own face
//   STRANGER = 0.3 axis 0 + 0.954 axis 2   0.30 to SHARP: just above the 0.28 match threshold
//   CLEAR    = axis 2                      the stranger's clear photo: 0.95 to STRANGER, 0 to SHARP
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PoolClient } from 'pg';
import {
	dropFromGallery,
	findCrossPumpMatch,
	findLocalMatch,
	galleryRules,
	keepsInGallery,
	saveFace
} from '../../worker/faceQueries.js';
import { markNotFraud } from '../../src/lib/server/fraudResolution';
import { TODAY, YESTERDAY, admin, area, db, face, person, pump, seen, session } from './fixtures';

const SHARP = face({ 0: 1 });
const STRANGER = face({ 0: 0.3, 2: 0.954 });
const CLEAR = face({ 2: 1 });
const MATCH_THRESHOLD = 0.28;
const RULES = { addThreshold: 0.4, margin: 0.1 };
const client = db as unknown as PoolClient;

before(() => db.connect());
after(() => db.end());

async function gallery(personId: string) {
	const { rows } = await db.query(
		`SELECT in_gallery, is_anchor FROM person_face_vectors WHERE person_id = $1
		 ORDER BY created_at, id`,
		[personId]
	);
	return rows as { in_gallery: boolean; is_anchor: boolean }[];
}

describe('keepsInGallery', () => {
	test('a weak match counts attendance but does not join the gallery', () => {
		assert.equal(keepsInGallery({ similarity: 0.3, runner_up_similarity: null }, RULES), false);
	});

	test('a close call between two workers does not join the gallery', () => {
		assert.equal(keepsInGallery({ similarity: 0.62, runner_up_similarity: 0.55 }, RULES), false);
	});

	test('a clear match joins the gallery', () => {
		assert.equal(keepsInGallery({ similarity: 0.62, runner_up_similarity: 0.2 }, RULES), true);
		assert.equal(keepsInGallery({ similarity: 0.4, runner_up_similarity: null }, RULES), true);
	});
});

describe('galleryRules', () => {
	test('defaults to 0.40 and a 0.10 margin, never below the match threshold', () => {
		assert.deepEqual(galleryRules(MATCH_THRESHOLD), RULES);
		assert.equal(galleryRules(0.5).addThreshold, 0.5);
	});
});

describe('findLocalMatch', () => {
	test('names the next-closest other worker', async () => {
		const { plantId } = await area();
		const a = await pump(plantId);
		const s = await session(a, TODAY);
		const near = await person(a);
		await seen(near, s, SHARP);
		await seen(near, await session(a, YESTERDAY), face({ 0: 0.9, 1: 0.436 }));
		const other = await person(a);
		await seen(other, s, face({ 0: 0.5, 1: 0.866 }));

		const match = await findLocalMatch(db, { vector: SHARP, pumpId: a });
		assert.equal(match?.person_id, near);
		assert.ok(Math.abs(match!.runner_up_similarity! - 0.5) < 0.01);
	});

	test('ignores faces kept out of the gallery', async () => {
		const { plantId } = await area();
		const a = await pump(plantId);
		const worker = await person(a);
		await seen(worker, await session(a, TODAY), SHARP, { inGallery: false });

		assert.equal(await findLocalMatch(db, { vector: SHARP, pumpId: a }), undefined);
	});
});

describe('saveFace', () => {
	test("a weak match does not teach the matcher the stranger's face", async () => {
		const { plantId } = await area();
		const a = await pump(plantId);
		const worker = await person(a);
		await seen(worker, await session(a, YESTERDAY), SHARP, { isAnchor: true });

		// Day 1: the stranger's poor photo matches the worker at 0.30.
		const day1 = await session(a, TODAY);
		const weak = await findLocalMatch(db, { vector: STRANGER, pumpId: a });
		assert.equal(weak?.person_id, worker);
		assert.ok(weak!.similarity >= MATCH_THRESHOLD);
		await saveFace(db, {
			personId: worker,
			sessionId: day1,
			vector: STRANGER,
			cropUrl: null,
			inGallery: keepsInGallery(weak!, RULES)
		});

		// Day 2: the stranger's clear photo is 0.95 to the day 1 face, 0 to the worker's own.
		// Had the day 1 face joined the gallery, the stranger would be this worker again.
		const next = await findLocalMatch(db, { vector: CLEAR, pumpId: a });
		assert.ok(next!.similarity < MATCH_THRESHOLD, `similarity ${next!.similarity}`);
	});

	test("the worker's first face survives six newer ones", async () => {
		const { plantId } = await area();
		const a = await pump(plantId);
		const worker = await person(a);
		const s = await session(a, TODAY);
		await saveFace(db, {
			personId: worker,
			sessionId: s,
			vector: SHARP,
			cropUrl: null,
			inGallery: true,
			isAnchor: true
		});
		for (let i = 1; i <= 6; i++) {
			await saveFace(db, {
				personId: worker,
				sessionId: s,
				vector: face({ 0: 1, [i]: 1 }),
				cropUrl: null,
				inGallery: true
			});
		}

		const faces = await gallery(worker);
		assert.equal(faces.length, 5);
		assert.equal(faces.filter((f) => f.is_anchor).length, 1);
	});

	test('a face kept out of the gallery is still seen by the cross-pump check', async () => {
		const { areaId, plantId } = await area();
		const [a, b] = [await pump(plantId), await pump(plantId)];
		const worker = await person(b);
		const today = await session(b, TODAY);
		await seen(worker, today, SHARP, { inGallery: false });

		const match = await findCrossPumpMatch(db, {
			vector: SHARP,
			sessionDate: TODAY,
			areaId,
			pumpId: a
		});
		assert.equal(match?.matched_session_id, today);
	});
});

describe('dropFromGallery', () => {
	test("an incorrect match leaves the gallery; the worker's anchor stays", async () => {
		const { plantId } = await area();
		const a = await pump(plantId);
		const worker = await person(a);
		const first = await session(a, YESTERDAY);
		await seen(worker, first, SHARP, { isAnchor: true });
		const wrong = await session(a, TODAY);
		await seen(worker, wrong, STRANGER);

		await dropFromGallery(db, worker, wrong);
		await dropFromGallery(db, worker, first);
		assert.deepEqual(await gallery(worker), [
			{ in_gallery: true, is_anchor: true },
			{ in_gallery: false, is_anchor: false }
		]);
	});
});

describe('markNotFraud', () => {
	test('a weak match restores attendance without joining the gallery', async () => {
		const { plantId } = await area();
		const [a, b] = [await pump(plantId), await pump(plantId)];
		const worker = await person(b);
		await seen(worker, await session(b, YESTERDAY), SHARP, { isAnchor: true });
		const flagged = await session(b, TODAY, 'morning', 'review');
		const elsewhere = await person(a);
		const sessionA = await session(a, TODAY);
		await seen(elsewhere, sessionA, STRANGER);
		const { rows } = await db.query(
			`INSERT INTO fraud_flags (session_id, person_id, matched_at_pump_id, matched_session_id,
			                          similarity_score, face_embedding)
			 VALUES ($1, $2, $3, $4, 0.9, $5::vector) RETURNING id`,
			[flagged, elsewhere, a, sessionA, STRANGER]
		);

		const result = await markNotFraud(client, rows[0].id, await admin());
		assert.deepEqual(result, { personId: worker, createdPerson: false });
		assert.deepEqual(await gallery(worker), [
			{ in_gallery: true, is_anchor: true },
			{ in_gallery: false, is_anchor: false }
		]);
	});
});
