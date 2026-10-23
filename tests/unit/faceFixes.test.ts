// Unit tests for the admin face fixes (src/lib/server/faceFixes.ts) and "Not fraud" on flags with
// no stored face (fraudResolution.ts). Run: npm run test:unit (scripts/run-unit.mjs).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PoolClient } from 'pg';
import {
	FaceFixError,
	markPresent,
	moveFace,
	resolveReviewFlag,
	undoMerge
} from '../../src/lib/server/faceFixes';
import { markNotFraud } from '../../src/lib/server/fraudResolution';
import { TODAY, YESTERDAY, admin, area, db, face, person, pump, seen, session } from './fixtures';

const client = db as unknown as PoolClient;
const A = face({ 0: 1 });
const B = face({ 1: 1 });

before(() => db.connect());
after(() => db.end());

async function days(personId: string) {
	const { rows } = await db.query(
		`SELECT session_date::text AS date, morning_matched AS start, evening_matched AS "end"
		 FROM daily_person_attendance WHERE person_id = $1 ORDER BY session_date`,
		[personId]
	);
	return rows;
}

async function faces(personId: string) {
	const { rows } = await db.query(
		`SELECT session_id, in_gallery, is_anchor FROM person_face_vectors WHERE person_id = $1
		 ORDER BY created_at`,
		[personId]
	);
	return rows;
}

async function evidence(sessionId: string) {
	const { rows } = await db.query(
		'SELECT person_id FROM attendance_face_evidence WHERE session_id = $1 ORDER BY person_id',
		[sessionId]
	);
	return rows.map((row) => row.person_id);
}

async function status(personId: string) {
	const { rows } = await db.query('SELECT status, name FROM persons WHERE id = $1', [personId]);
	return rows[0];
}

async function yearly(personId: string) {
	const { rows } = await db.query(
		'SELECT days_present, days_morning_only FROM person_attendance_yearly WHERE person_id = $1',
		[personId]
	);
	return rows[0];
}

// The same steps as the Merge review "confirm" action, for undoMerge to reverse.
async function merge(kept: string, merged: string, adminId: string) {
	await db.query('UPDATE daily_person_attendance SET person_id = $1 WHERE person_id = $2', [
		kept,
		merged
	]);
	await db.query('UPDATE person_face_vectors SET person_id = $1 WHERE person_id = $2', [
		kept,
		merged
	]);
	await db.query(`UPDATE persons SET status = 'merged', merged_into_person_id = $1 WHERE id = $2`, [
		kept,
		merged
	]);
	const { rows } = await db.query(
		`INSERT INTO person_merge_log (kept_person_id, merged_person_id, admin_id, similarity_score)
		 VALUES ($1, $2, $3, 0.25) RETURNING id`,
		[kept, merged, adminId]
	);
	return rows[0].id as string;
}

async function setup() {
	const { plantId } = await area();
	return { pump: await pump(plantId), plantId, adminId: await admin() };
}

describe('moveFace', () => {
	test('moves the face, evidence and shift slot to the right worker', async () => {
		const { pump: p, adminId } = await setup();
		const wrong = await person(p);
		await seen(wrong, await session(p, YESTERDAY), A);
		const right = await person(p);
		const photo = await session(p, TODAY);
		await seen(wrong, photo, B);

		await moveFace(client, { sessionId: photo, fromPersonId: wrong, toPersonId: right, adminId });
		assert.deepEqual(await evidence(photo), [right]);
		assert.deepEqual(await days(wrong), [{ date: YESTERDAY, start: true, end: false }]);
		assert.deepEqual(await days(right), [{ date: TODAY, start: true, end: false }]);
		assert.deepEqual(await faces(right), [
			{ session_id: photo, in_gallery: true, is_anchor: false }
		]);
		assert.equal((await faces(wrong)).length, 1);
	});

	test('to a new worker: active, named, the face is their anchor', async () => {
		const { pump: p, adminId } = await setup();
		const wrong = await person(p);
		await seen(wrong, await session(p, YESTERDAY), A);
		const photo = await session(p, TODAY);
		await seen(wrong, photo, B);

		const result = await moveFace(client, {
			sessionId: photo,
			fromPersonId: wrong,
			toPersonId: null,
			name: 'Suresh Kumar',
			adminId
		});
		assert.equal(result.createdPerson, true);
		assert.deepEqual(await status(result.personId), { status: 'active', name: 'Suresh Kumar' });
		assert.deepEqual(await faces(result.personId), [
			{ session_id: photo, in_gallery: true, is_anchor: true }
		]);
	});

	test('a worker left with nothing after the move is retired', async () => {
		const { pump: p, adminId } = await setup();
		const onlyThisFace = await person(p, 'pending_review');
		const right = await person(p);
		const photo = await session(p, TODAY);
		await seen(onlyThisFace, photo, A);

		await moveFace(client, {
			sessionId: photo,
			fromPersonId: onlyThisFace,
			toPersonId: right,
			adminId
		});
		assert.equal((await status(onlyThisFace)).status, 'archived');
	});

	test('one face per worker: refuses a worker already in the photo, or of another pump', async () => {
		const { pump: p, plantId, adminId } = await setup();
		const other = await pump(plantId);
		const [x, y, elsewhere] = [await person(p), await person(p), await person(other)];
		const photo = await session(p, TODAY);
		await seen(x, photo, A);
		await seen(y, photo, B);

		await assert.rejects(
			moveFace(client, { sessionId: photo, fromPersonId: x, toPersonId: y, adminId }),
			/already has a face in this photo/
		);
		await assert.rejects(
			moveFace(client, { sessionId: photo, fromPersonId: x, toPersonId: elsewhere, adminId }),
			FaceFixError
		);
	});
});

describe('markPresent', () => {
	test('counts a worker the camera missed, once', async () => {
		const { pump: p, adminId } = await setup();
		const missed = await person(p);
		const photo = await session(p, TODAY, 'evening');

		await markPresent(client, { sessionId: photo, personId: missed, adminId });
		assert.deepEqual(await evidence(photo), [missed]);
		assert.deepEqual(await days(missed), [{ date: TODAY, start: false, end: true }]);
		assert.deepEqual(await faces(missed), []);
		await assert.rejects(
			markPresent(client, { sessionId: photo, personId: missed, adminId }),
			/already counted/
		);
	});

	test('adds a never-detected worker by name; a name in use is refused', async () => {
		const { pump: p, adminId } = await setup();
		const photo = await session(p, TODAY);
		// A closed start, so the day counts as start only in the yearly total.
		await db.query(`UPDATE attendance_sessions SET pairing_status = 'expired' WHERE id = $1`, [
			photo
		]);

		const { personId } = await markPresent(client, {
			sessionId: photo,
			personId: null,
			name: 'Ramesh',
			adminId
		});
		assert.deepEqual(await status(personId), { status: 'active', name: 'Ramesh' });
		assert.deepEqual(await yearly(personId), { days_present: 0, days_morning_only: 1 });
		await assert.rejects(
			markPresent(client, { sessionId: photo, personId: null, name: 'ramesh', adminId }),
			/already named/
		);
	});
});

describe('undoMerge', () => {
	test('the merged worker gets back their photos; the kept worker keeps theirs', async () => {
		const { pump: p, adminId } = await setup();
		const kept = await person(p);
		const keptPhoto = await session(p, YESTERDAY);
		await seen(kept, keptPhoto, A, { isAnchor: true });
		const merged = await person(p);
		const mergedPhoto = await session(p, TODAY);
		await seen(merged, mergedPhoto, B, { isAnchor: true });
		const logId = await merge(kept, merged, adminId);
		assert.equal((await days(kept)).length, 2);

		const result = await undoMerge(client, logId, adminId);
		assert.equal(result.photos, 1);
		assert.equal((await status(merged)).status, 'active');
		assert.deepEqual(await days(kept), [{ date: YESTERDAY, start: true, end: false }]);
		assert.deepEqual(await days(merged), [{ date: TODAY, start: true, end: false }]);
		assert.deepEqual(await faces(merged), [
			{ session_id: mergedPhoto, in_gallery: true, is_anchor: true }
		]);
		assert.deepEqual(await faces(kept), [
			{ session_id: keptPhoto, in_gallery: true, is_anchor: true }
		]);
		await assert.rejects(undoMerge(client, logId, adminId), /already undone/);
	});
});

describe('resolveReviewFlag', () => {
	async function flag(sessionId: string, personId: string | null, adminId: string) {
		const { rows } = await db.query(
			`INSERT INTO attendance_review_flags (session_id, person_id, reason, flagged_by_admin_id)
			 VALUES ($1, $2, 'incorrect_match', $3) RETURNING id`,
			[sessionId, personId, adminId]
		);
		return rows[0].id as string;
	}

	async function closed(flagId: string) {
		const { rows } = await db.query(
			'SELECT status, resolution, resolved_person_id FROM attendance_review_flags WHERE id = $1',
			[flagId]
		);
		return rows[0];
	}

	test('"Move face" fixes the face and closes the flag; a closed flag stays closed', async () => {
		const { pump: p, adminId } = await setup();
		const [wrong, right] = [await person(p), await person(p)];
		await seen(wrong, await session(p, YESTERDAY), A);
		const photo = await session(p, TODAY);
		await seen(wrong, photo, B);
		const flagId = await flag(photo, wrong, adminId);

		await resolveReviewFlag(client, flagId, adminId, { action: 'move', personId: right });
		assert.deepEqual(await closed(flagId), {
			status: 'resolved',
			resolution: 'moved',
			resolved_person_id: right
		});
		await assert.rejects(
			resolveReviewFlag(client, flagId, adminId, { action: 'dismiss' }),
			/already closed/
		);
	});

	test('"Mark present" on a photo flag and "Dismiss" close it', async () => {
		const { pump: p, adminId } = await setup();
		const missed = await person(p);
		const photo = await session(p, TODAY);
		const missing = await flag(photo, null, adminId);
		await resolveReviewFlag(client, missing, adminId, { action: 'mark_present', personId: missed });
		assert.equal((await closed(missing)).resolution, 'marked_present');

		const other = await flag(photo, null, adminId);
		await resolveReviewFlag(client, other, adminId, { action: 'dismiss' });
		assert.deepEqual(await closed(other), {
			status: 'resolved',
			resolution: 'dismissed',
			resolved_person_id: null
		});
	});
});

describe('markNotFraud without a stored face', () => {
	test('marks the worker the admin chose; without a choice it asks for one', async () => {
		const { pump: b, plantId, adminId } = await setup();
		const a = await pump(plantId);
		const worker = await person(b);
		const flagged = await session(b, TODAY, 'morning', 'review');
		const elsewhere = await person(a);
		const sessionA = await session(a, TODAY);
		await seen(elsewhere, sessionA, A);
		const { rows } = await db.query(
			`INSERT INTO fraud_flags (session_id, person_id, matched_at_pump_id, matched_session_id,
			                          similarity_score)
			 VALUES ($1, $2, $3, $4, 0.9) RETURNING id`,
			[flagged, elsewhere, a, sessionA]
		);

		await assert.rejects(markNotFraud(client, rows[0].id, adminId), /Choose the worker/);
		const result = await markNotFraud(client, rows[0].id, adminId, worker);
		assert.deepEqual(result, { personId: worker, createdPerson: false });
		assert.deepEqual(await days(worker), [{ date: TODAY, start: true, end: false }]);
		assert.deepEqual(await faces(worker), []);
	});
});
