// OPR: the operator photo sent with every shift photo. The operator is counted like a worker and
// tagged "Operator"; an operator who is also in the group photo is counted once.
import { test, expect } from '@playwright/test';
import { count, createArea, createPump, db, login, photo, submit, waitForSession } from './helpers';

async function pumpContext() {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	return { pump, context: await login(pump.email) };
}

test('OPR-01 a shift photo without the operator photo is refused and nothing is stored', async () => {
	const { pump, context } = await pumpContext();
	const submitted = await submit(context, await photo(['OPR01']), 'image/jpeg', null);
	expect(submitted.status).toBe(400);
	expect(submitted.body.error).toMatch(/operator/i);
	expect(await count('SELECT 1 FROM attendance_sessions WHERE pump_id = $1', [pump.id])).toBe(0);
});

test('OPR-02 an operator who is not in the group photo is an extra person tagged Operator', async () => {
	const { pump, context } = await pumpContext();
	const submitted = await submit(
		context,
		await photo(['OPR02-A', 'OPR02-B']),
		'image/jpeg',
		await photo(['OPR02-OP'])
	);
	expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
	const session = await waitForSession(submitted.body.session_id, ['review']);

	const { rows: people } = await db.query(
		'SELECT is_operator FROM persons WHERE pump_id = $1 ORDER BY display_seq',
		[pump.id]
	);
	expect(people.map((p) => p.is_operator)).toEqual([false, false, true]);
	expect(
		await count('SELECT 1 FROM attendance_face_evidence WHERE session_id = $1 AND is_operator', [
			session.id
		])
	).toBe(1);

	const status = await (await context.get(`/api/attendance/status/${session.id}`)).json();
	expect(status.new_persons.filter((p: { is_operator: boolean }) => p.is_operator)).toHaveLength(1);
	expect(status.operator_photo_url).toMatch(/\/api\/attendance\/photo\/.+\?kind=operator$/);
});

test('OPR-03 an operator who is also in the group photo is counted once', async () => {
	const { pump, context } = await pumpContext();
	const submitted = await submit(
		context,
		await photo(['OPR03-A', 'OPR03-OP']),
		'image/jpeg',
		await photo(['OPR03-OP'])
	);
	expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
	const session = await waitForSession(submitted.body.session_id, ['review']);
	const { rows: people } = await db.query(
		'SELECT is_operator FROM persons WHERE pump_id = $1 ORDER BY display_seq',
		[pump.id]
	);
	expect(people.map((p) => p.is_operator)).toEqual([false, true]);
	expect(
		await count('SELECT 1 FROM attendance_face_evidence WHERE session_id = $1', [session.id])
	).toBe(2);
});

test('OPR-04 an operator photo with no face fails at once with a clear reason', async () => {
	const { context } = await pumpContext();
	const submitted = await submit(context, await photo(['OPR04']), 'image/jpeg', await photo([]));
	expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
	const session = await waitForSession(submitted.body.session_id, ['failed', 'review']);
	expect(session.status).toBe('failed');
	expect(session.error_reason).toMatch(/operator photo/i);
	const { rows } = await db.query('SELECT attempts FROM attendance_jobs WHERE session_id = $1', [
		session.id
	]);
	expect(rows[0].attempts).toBe(1);
});

test('OPR-05 the operator photo is served and the same photo cannot be sent twice', async () => {
	const { context } = await pumpContext();
	const operator = await photo(['OPR05-OP']);
	const first = await submit(context, await photo(['OPR05-A']), 'image/jpeg', operator);
	expect(first.status, JSON.stringify(first.body)).toBe(202);
	await waitForSession(first.body.session_id, ['review']);

	const served = await context.get(`/api/attendance/photo/${first.body.session_id}?kind=operator`);
	expect(served.status()).toBe(200);
	expect(Buffer.compare(await served.body(), operator)).toBe(0);

	// The same operator photo again, even with a new group photo, is a duplicate.
	const second = await submit(context, await photo(['OPR05-A']), 'image/jpeg', operator);
	expect(second.status).toBe(409);
	// The group photo cannot double as the operator photo either.
	const group = await photo(['OPR05-B']);
	expect((await submit(context, group, 'image/jpeg', group)).status).toBe(400);
});
