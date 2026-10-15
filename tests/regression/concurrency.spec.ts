// CONC: five pumps in one Area submitting at the same instant, plus the double-tap and
// same-moment races a single pump can cause. Two workers process the queue (see
// scripts/run-regression.mjs), so jobs also race across workers.
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
	createArea,
	createPump,
	db,
	login,
	photo,
	shiftBack,
	stubCalls,
	submit,
	waitForSession,
	type Pump
} from './helpers';

const PUMPS = 5;
const WORKERS_PER_PUMP = 6;

type Station = { pump: Pump; context: APIRequestContext };

async function fivePumpsInOneArea(): Promise<Station[]> {
	const { plantId } = await createArea();
	const pumps = await Promise.all(Array.from({ length: PUMPS }, () => createPump(plantId)));
	return Promise.all(pumps.map(async (pump) => ({ pump, context: await login(pump.email) })));
}

function crew(tag: string, pumpIndex: number) {
	return Array.from({ length: WORKERS_PER_PUMP }, (_, i) => `${tag}-P${pumpIndex}-W${i}`);
}

async function submitAll(stations: Station[], buffers: Buffer[]) {
	return Promise.all(stations.map((station, i) => submit(station.context, buffers[i])));
}

async function approveAll(stations: Station[], sessionIds: string[]) {
	return Promise.all(
		stations.map((station, i) => station.context.post(`/api/attendance/approve/${sessionIds[i]}`))
	);
}

async function evidencePerSession(sessionIds: string[]) {
	const { rows } = await db.query(
		`SELECT session_id, count(*)::int AS n FROM attendance_face_evidence
		 WHERE session_id = ANY($1) GROUP BY session_id`,
		[sessionIds]
	);
	return Object.fromEntries(rows.map((row) => [row.session_id, row.n]));
}

test('CONC-01 five pumps, one Area, same instant: every photo is processed exactly once', async () => {
	const stations = await fivePumpsInOneArea();
	const buffers = await Promise.all(stations.map((_, i) => photo(crew('CONC01', i))));

	const submitted = await submitAll(stations, buffers);
	for (const result of submitted) expect(result.status, JSON.stringify(result.body)).toBe(202);
	const ids = submitted.map((result) => result.body.session_id as string);

	const sessions = await Promise.all(
		ids.map((id) => waitForSession(id, ['review', 'failed'], 30_000))
	);
	for (const session of sessions) expect(session.status).toBe('review');

	const evidence = await evidencePerSession(ids);
	for (const id of ids) expect(evidence[id]).toBe(WORKERS_PER_PUMP);
	for (const buffer of buffers) expect(await stubCalls(buffer)).toBe(1);

	// No worker invented a fraud flag between pumps that share nobody.
	const { rows: flags } = await db.query(
		'SELECT count(*)::int AS n FROM fraud_flags WHERE session_id = ANY($1)',
		[ids]
	);
	expect(flags[0].n).toBe(0);

	// Each pump numbers its own workers 1..6 with no gaps or duplicates.
	for (const { pump } of stations) {
		const { rows } = await db.query(
			'SELECT display_seq FROM persons WHERE pump_id = $1 ORDER BY display_seq',
			[pump.id]
		);
		expect(rows.map((row) => row.display_seq)).toEqual([1, 2, 3, 4, 5, 6]);
	}
	const { rows: jobs } = await db.query(
		`SELECT status, count(*)::int AS n FROM attendance_jobs WHERE session_id = ANY($1) GROUP BY status`,
		[ids]
	);
	expect(jobs).toEqual([{ status: 'done', n: PUMPS }]);
});

test('CONC-02 one worker in all five photos at once is counted at one pump and flagged at the other four', async () => {
	const stations = await fivePumpsInOneArea();
	const buffers = await Promise.all(
		stations.map((_, i) => photo(['CONC02-SHARED', ...crew('CONC02', i).slice(0, 3)]))
	);

	const submitted = await submitAll(stations, buffers);
	for (const result of submitted) expect(result.status).toBe(202);
	const ids = submitted.map((result) => result.body.session_id as string);
	await Promise.all(ids.map((id) => waitForSession(id, ['review'], 30_000)));

	const evidence = await evidencePerSession(ids);
	const counts = ids.map((id) => evidence[id]).sort();
	// Four pumps keep only their own 3 workers; one pump also has the shared worker.
	expect(counts).toEqual([3, 3, 3, 3, 4]);

	const { rows: flags } = await db.query(
		'SELECT session_id, person_id FROM fraud_flags WHERE session_id = ANY($1)',
		[ids]
	);
	expect(flags).toHaveLength(4);
	// Every flag points at the same person: the one the winning pump created.
	expect(new Set(flags.map((flag) => flag.person_id)).size).toBe(1);
	const winner = ids.find((id) => evidence[id] === 4);
	expect(flags.map((flag) => flag.session_id)).not.toContain(winner);
});

test('CONC-03 five full shifts at once: start, approve, end, approve all race and still count one day each', async () => {
	const stations = await fivePumpsInOneArea();
	const crews = stations.map((_, i) => crew('CONC03', i));

	const starts = await submitAll(stations, await Promise.all(crews.map((c) => photo(c))));
	const startIds = starts.map((result) => result.body.session_id as string);
	await Promise.all(startIds.map((id) => waitForSession(id, ['review'], 30_000)));
	const startApprovals = await approveAll(stations, startIds);
	for (const response of startApprovals) expect(response.status()).toBe(200);

	for (const id of startIds) await shiftBack(id, 600);
	const ends = await submitAll(stations, await Promise.all(crews.map((c) => photo(c))));
	for (const result of ends) expect(result.status, JSON.stringify(result.body)).toBe(202);
	const endIds = ends.map((result) => result.body.session_id as string);
	await Promise.all(endIds.map((id) => waitForSession(id, ['review'], 30_000)));

	// The end photos matched the same people; nobody was created twice.
	for (const { pump } of stations) {
		const { rows } = await db.query('SELECT count(*)::int AS n FROM persons WHERE pump_id = $1', [
			pump.id
		]);
		expect(rows[0].n).toBe(WORKERS_PER_PUMP);
	}

	const endApprovals = await approveAll(stations, endIds);
	for (const response of endApprovals) expect(response.status()).toBe(200);

	const pumpIds = stations.map((station) => station.pump.id);
	const { rows: yearly } = await db.query(
		`SELECT coalesce(sum(y.days_present), 0)::int AS present,
		        coalesce(sum(y.days_morning_only + y.days_evening_only), 0)::int AS partial
		 FROM person_attendance_yearly y JOIN persons p ON p.id = y.person_id
		 WHERE p.pump_id = ANY($1)`,
		[pumpIds]
	);
	expect(yearly[0]).toEqual({ present: PUMPS * WORKERS_PER_PUMP, partial: 0 });
});

test('CONC-04 a pump that taps submit five times at once gets one shift start, not five', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const context = await login(pump.email);

	const results = await Promise.all(
		Array.from({ length: 5 }, async () => submit(context, await photo(['CONC04'])))
	);
	const statuses = results.map((result) => result.status).sort();
	expect(statuses).toEqual([202, 409, 409, 409, 409]);
	const { rows } = await db.query(
		'SELECT count(*)::int AS n FROM attendance_sessions WHERE pump_id = $1',
		[pump.id]
	);
	expect(rows[0].n).toBe(1);
});

test('CONC-05 approve tapped three times at once completes the shift once and counts it once', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const context = await login(pump.email);
	const start = await submit(context, await photo(['CONC05']));
	await waitForSession(start.body.session_id, ['review']);
	expect((await context.post(`/api/attendance/approve/${start.body.session_id}`)).status()).toBe(
		200
	);
	await shiftBack(start.body.session_id, 600);
	const end = await submit(context, await photo(['CONC05']));
	await waitForSession(end.body.session_id, ['review']);

	const responses = await Promise.all(
		Array.from({ length: 3 }, () => context.post(`/api/attendance/approve/${end.body.session_id}`))
	);
	expect(responses.map((response) => response.status()).sort()).toEqual([200, 409, 409]);
	const { rows } = await db.query(
		`SELECT y.days_present FROM person_attendance_yearly y JOIN persons p ON p.id = y.person_id
		 WHERE p.pump_id = $1`,
		[pump.id]
	);
	expect(rows).toEqual([{ days_present: 1 }]);
});

test('CONC-06 End session and an end photo at the same instant: exactly one of them wins', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const context = await login(pump.email);
	const start = await submit(context, await photo(['CONC06']));
	await waitForSession(start.body.session_id, ['review']);
	await context.post(`/api/attendance/approve/${start.body.session_id}`);
	await shiftBack(start.body.session_id, 600);

	const endPhoto = await photo(['CONC06']);
	const [ended, submitted] = await Promise.all([
		context.post('/api/attendance/end'),
		submit(context, endPhoto)
	]);
	const endWon = ended.status() === 200;
	const photoWon = submitted.status === 202;
	expect(endWon !== photoWon, `end ${ended.status()}, photo ${submitted.status}`).toBe(true);

	const { rows } = await db.query(
		'SELECT pairing_status, closed_by FROM attendance_sessions WHERE id = $1',
		[start.body.session_id]
	);
	if (endWon) expect(rows[0]).toEqual({ pairing_status: 'expired', closed_by: 'pump' });
	else expect(rows[0].pairing_status).toBe('paired');
});

test('CONC-07 the same photo sent by two pumps at the same instant is accepted once', async () => {
	const { plantId } = await createArea();
	const [first, second] = await Promise.all([createPump(plantId), createPump(plantId)]);
	const [a, b] = await Promise.all([login(first.email), login(second.email)]);
	const shared = await photo(['CONC07']);

	const results = await Promise.all([submit(a, shared), submit(b, shared)]);
	expect(results.map((result) => result.status).sort()).toEqual([202, 409]);
});

test('CONC-08 five pumps with a slow AI service (1.5 s per photo) all finish without a retry', async () => {
	const stations = await fivePumpsInOneArea();
	const buffers = await Promise.all(
		stations.map((_, i) => photo(crew('CONC08', i), { delayMs: 1500 }))
	);
	const started = Date.now();
	const submitted = await submitAll(stations, buffers);
	const ids = submitted.map((result) => result.body.session_id as string);
	const sessions = await Promise.all(
		ids.map((id) => waitForSession(id, ['review', 'failed'], 30_000))
	);
	const seconds = (Date.now() - started) / 1000;

	for (const session of sessions) expect(session.status).toBe('review');
	for (const buffer of buffers) expect(await stubCalls(buffer)).toBe(1);
	// Two workers, four photos each at a time: five slow photos overlap instead of queueing.
	test
		.info()
		.annotations.push({ type: 'duration', description: `${seconds.toFixed(1)} s for 5 pumps` });
	expect(seconds).toBeLessThan(12);
});
