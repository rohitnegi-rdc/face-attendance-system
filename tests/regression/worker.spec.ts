// WRK: the background worker on its own, including the failures it has to survive: a worker
// that dies mid-job, an AI service that errors, times out or is slow, a photo missing on disk.
// The regression runner starts two workers, so every scenario also runs with a second worker
// competing for the same queue.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
	BASE_URL,
	createArea,
	createPump,
	db,
	login,
	photo,
	stubCalls,
	submit,
	waitForSession
} from './helpers';

const UPLOAD_DIR =
	process.env.REGRESSION_UPLOAD_DIR ??
	path.resolve('test-output', 'regression', 'adhoc', 'uploads');

// Puts a session and its job straight into the state a worker leaves behind, without going
// through submit (where the running workers would pick it up at once).
async function leftBehindJob(
	pumpId: string,
	buffer: Buffer | null,
	job: {
		status: 'queued' | 'claimed';
		attempts: number;
		claimedMinutesAgo?: number;
		claimedBy?: string;
	}
) {
	const photoPath = path.join(UPLOAD_DIR, `${randomUUID()}.jpg`);
	if (buffer) {
		await fs.mkdir(UPLOAD_DIR, { recursive: true });
		await fs.writeFile(photoPath, buffer);
	}
	const { rows } = await db.query(
		`INSERT INTO attendance_sessions
		   (pump_id, session_date, session_type, status, pairing_status, photo_url, photo_hash)
		 VALUES ($1, (now() AT TIME ZONE 'Asia/Kolkata')::date, 'morning', $2, 'open', $3, $4)
		 RETURNING id`,
		[
			pumpId,
			job.status === 'claimed' ? 'processing' : 'pending',
			photoPath,
			crypto.randomBytes(32).toString('hex')
		]
	);
	const sessionId = rows[0].id as string;
	await db.query(
		`INSERT INTO attendance_jobs (session_id, request_id, status, attempts, claimed_at, claimed_by)
		 VALUES ($1, $2, $3, $4,
		         CASE WHEN $3 = 'claimed' THEN now() - make_interval(mins => $5) END, $6)`,
		[
			sessionId,
			randomUUID(),
			job.status,
			job.attempts,
			job.claimedMinutesAgo ?? 0,
			job.claimedBy ?? null
		]
	);
	return sessionId;
}

async function jobOf(sessionId: string) {
	const { rows } = await db.query('SELECT * FROM attendance_jobs WHERE session_id = $1', [
		sessionId
	]);
	return rows[0];
}

async function evidenceCount(sessionId: string) {
	const { rows } = await db.query(
		'SELECT count(*)::int AS n FROM attendance_face_evidence WHERE session_id = $1',
		[sessionId]
	);
	return rows[0].n as number;
}

async function newPump() {
	const { plantId } = await createArea();
	return createPump(plantId);
}

test('WRK-03 a job left claimed by a crashed worker is picked up again and processed once', async () => {
	const pump = await newPump();
	const buffer = await photo(['WRK03-A', 'WRK03-B']);
	const sessionId = await leftBehindJob(pump.id, buffer, {
		status: 'claimed',
		attempts: 1,
		claimedMinutesAgo: 11,
		claimedBy: 'crashed-worker'
	});

	const session = await waitForSession(sessionId, ['review', 'failed']);
	expect(session.status).toBe('review');
	expect(await evidenceCount(sessionId)).toBe(2);
	expect(await stubCalls(buffer)).toBe(1);
	const job = await jobOf(sessionId);
	expect(job.status).toBe('done');
	expect(job.attempts).toBe(2);
});

test('WRK-08 a worker that dies on the last attempt does not leave the photo stuck in processing', async () => {
	const pump = await newPump();
	const sessionId = await leftBehindJob(pump.id, await photo(['WRK08']), {
		status: 'claimed',
		attempts: 3,
		claimedMinutesAgo: 11,
		claimedBy: 'crashed-worker'
	});

	const session = await waitForSession(sessionId, ['failed', 'review']);
	expect(session.status).toBe('failed');
	expect(session.error_reason).toMatch(/stopped|try again|retry/i);
	expect((await jobOf(sessionId)).status).toBe('error');

	// A stuck job used to keep /api/health at 503, which also fails every deploy health check.
	const health = await fetch(`${BASE_URL}/api/health`).then((r) => r.json());
	expect(health.queue.stale_claimed_jobs).toBe(0);

	// The pump can clear it and carry on.
	const context = await login(pump.email);
	const retried = await context.post(`/api/attendance/retry/${sessionId}`);
	expect(retried.status(), await retried.text()).toBe(200);
});

test('WRK-09 a restarted worker releases its own unfinished jobs at once, not after the timeout', async () => {
	const pump = await newPump();
	const workerName = `restarted-${randomUUID().slice(0, 8)}`;
	const sessionId = await leftBehindJob(pump.id, await photo(['WRK09']), {
		status: 'claimed',
		attempts: 1,
		claimedMinutesAgo: 0,
		claimedBy: workerName
	});

	// Same name as the worker that "died": in Docker the name is the container hostname, which
	// survives a container restart.
	const worker = spawn(process.execPath, ['worker/index.js'], {
		env: {
			...process.env,
			HOSTNAME: workerName,
			DATABASE_URL: process.env.REGRESSION_DATABASE_URL,
			AI_SERVICE_URL: process.env.REGRESSION_STUB_URL ?? 'http://127.0.0.1:58000',
			WORKER_HEARTBEAT_INTERVAL_MS: '1000'
		},
		stdio: 'ignore'
	});
	try {
		const session = await waitForSession(sessionId, ['review', 'failed'], 15_000);
		expect(session.status).toBe('review');
	} finally {
		worker.kill();
	}
});

test('WRK-10 the AI service failing twice is retried with a pause, then the photo is processed', async () => {
	const pump = await newPump();
	const context = await login(pump.email);
	const buffer = await photo(['WRK10'], { failTimes: 2 });
	const submitted = await submit(context, buffer);
	expect(submitted.status).toBe(202);

	// Backoff: after the first failure the job waits before the next attempt.
	const deadline = Date.now() + 10_000;
	while ((await stubCalls(buffer)) < 1 && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 100));
	}
	await new Promise((r) => setTimeout(r, 800));
	expect(await stubCalls(buffer)).toBe(1);
	const waiting = await db.query(
		'SELECT status, error_reason FROM attendance_sessions WHERE id = $1',
		[submitted.body.session_id]
	);
	expect(waiting.rows[0].status).toBe('pending');

	const session = await waitForSession(submitted.body.session_id, ['review', 'failed'], 30_000);
	expect(session.status).toBe('review');
	expect(session.error_reason).toBeNull();
	expect(await stubCalls(buffer)).toBe(3);
	expect(await evidenceCount(submitted.body.session_id)).toBe(1);
});

test('WRK-11 an AI service that never answers in time ends in a readable failure', async () => {
	const pump = await newPump();
	const context = await login(pump.email);
	// The regression runner sets AI_REQUEST_TIMEOUT_MS to 3000.
	const submitted = await submit(context, await photo(['WRK11'], { delayMs: 4500 }));
	expect(submitted.status).toBe(202);

	const session = await waitForSession(submitted.body.session_id, ['failed', 'review'], 45_000);
	expect(session.status).toBe('failed');
	expect(session.error_reason).toMatch(/face service/i);
	expect(session.error_reason).not.toMatch(/abort|ECONN|stack/i);
	const job = await jobOf(submitted.body.session_id);
	expect(job.status).toBe('error');
	expect(job.attempts).toBe(3);
	expect(job.last_error).toMatch(/timeout|abort/i);
});

test('WRK-12 a photo missing on disk fails with a readable reason, not a file path', async () => {
	const pump = await newPump();
	const sessionId = await leftBehindJob(pump.id, null, { status: 'queued', attempts: 0 });

	const session = await waitForSession(sessionId, ['failed', 'review'], 30_000);
	expect(session.status).toBe('failed');
	expect(session.error_reason).toMatch(/photo/i);
	expect(session.error_reason).not.toMatch(/ENOENT|[\\/]uploads/);
});

test('WRK-13 both workers report a heartbeat', async () => {
	const { rows } = await db.query(
		`SELECT count(*)::int AS n FROM worker_heartbeats WHERE last_seen_at > now() - interval '10 seconds'`
	);
	expect(rows[0].n).toBeGreaterThanOrEqual(2);
});

test('WRK-14 a slow AI service (2 s per photo) still finishes every photo', async () => {
	const pump = await newPump();
	const context = await login(pump.email);
	const submitted = await submit(context, await photo(['WRK14-A', 'WRK14-B'], { delayMs: 2000 }));
	expect(submitted.status).toBe(202);
	const session = await waitForSession(submitted.body.session_id, ['review', 'failed'], 20_000);
	expect(session.status).toBe('review');
	expect(await evidenceCount(submitted.body.session_id)).toBe(2);
});
