import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const { Pool } = pg;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE_URL =
	process.env.DATABASE_URL || 'postgres://attendance:attendance@127.0.0.1:5433/attendance';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PROFILE =
	process.argv.find((value) => value.startsWith('--profile='))?.split('=')[1] || 'all';
const pool = new Pool({ connectionString: DATABASE_URL });

type Pump = { id: string; pump_code: string; login_email: string };
type Submission = {
	pump: Pump;
	status: number;
	body: any;
	elapsed_ms: number;
};

function percentile(values: number[], percentileValue: number) {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

function cookieFor(pump: Pump) {
	const token = jwt.sign({ role: 'pump', id: pump.id, email: pump.login_email }, JWT_SECRET, {
		expiresIn: '4h'
	});
	return `session=${token}`;
}

async function insertPump(plantId: string, vendorId: string, code: string): Promise<Pump> {
	const email = `${code.toLowerCase()}@e2e.local`;
	const { rows } = await pool.query<Pump>(
		`INSERT INTO pumps (plant_id, vendor_id, pump_code, login_email, password_hash)
		 VALUES ($1, $2, $3, $4, 'e2e-unused')
		 RETURNING id, pump_code, login_email`,
		[plantId, vendorId, code, email]
	);
	return rows[0];
}

async function createHierarchy(runTag: string) {
	const vendorResult = await pool.query<{ id: string }>(
		`INSERT INTO vendors (name, email, password_hash)
		 VALUES ($1, $2, 'e2e-unused') RETURNING id`,
		[`E2E Vendor ${runTag}`, `vendor-${runTag.toLowerCase()}@e2e.local`]
	);
	const vendorId = vendorResult.rows[0].id;

	const sharedArea = await pool.query<{ id: string }>(
		`INSERT INTO areas (name) VALUES ($1) RETURNING id`,
		[`E2E Shared Area ${runTag}`]
	);
	const sharedPlant = await pool.query<{ id: string }>(
		`INSERT INTO plants (area_id, name) VALUES ($1, $2) RETURNING id`,
		[sharedArea.rows[0].id, `E2E Shared Plant ${runTag}`]
	);

	const samePump = await insertPump(
		sharedPlant.rows[0].id,
		vendorId,
		`E2E${runTag}ONE`.slice(0, 28)
	);
	const sameAreaPumps: Pump[] = [];
	for (let index = 1; index <= 20; index += 1) {
		sameAreaPumps.push(
			await insertPump(
				sharedPlant.rows[0].id,
				vendorId,
				`E2E${runTag}S${String(index).padStart(2, '0')}`.slice(0, 28)
			)
		);
	}

	const independentPumps: Pump[] = [];
	for (let index = 1; index <= 20; index += 1) {
		const area = await pool.query<{ id: string }>(
			`INSERT INTO areas (name) VALUES ($1) RETURNING id`,
			[`E2E Independent ${runTag} ${index}`]
		);
		const plant = await pool.query<{ id: string }>(
			`INSERT INTO plants (area_id, name) VALUES ($1, $2) RETURNING id`,
			[area.rows[0].id, `E2E Independent Plant ${runTag} ${index}`]
		);
		independentPumps.push(
			await insertPump(
				plant.rows[0].id,
				vendorId,
				`E2E${runTag}I${String(index).padStart(2, '0')}`.slice(0, 28)
			)
		);
	}
	return { samePump, sameAreaPumps, independentPumps };
}

async function loadCorpus() {
	const fixtureRoot = path.join(ROOT, 'tests', 'fixtures', 'group-e2e');
	const manifest = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8'));
	return Promise.all(
		manifest.photos.map(async (entry: any) => ({
			entry,
			bytes: await fs.readFile(path.join(fixtureRoot, 'photos', entry.filename))
		}))
	);
}

function uniqueJpeg(bytes: Buffer, marker: string) {
	return Buffer.concat([bytes, Buffer.from(`\nE2E-MARKER:${marker}:${crypto.randomUUID()}\n`)]);
}

async function submit(pump: Pump, bytes: Buffer, filename: string): Promise<Submission> {
	const form = new FormData();
	form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), filename);
	form.append('lat', '12.9716');
	form.append('lng', '77.5946');
	const startedAt = performance.now();
	const response = await fetch(`${APP_URL}/api/attendance/submit`, {
		method: 'POST',
		headers: { cookie: cookieFor(pump), origin: APP_URL },
		body: form
	});
	const elapsed_ms = performance.now() - startedAt;
	const rawBody = await response.text();
	let body: any = { raw: rawBody };
	try {
		body = JSON.parse(rawBody);
	} catch {}
	return { pump, status: response.status, body, elapsed_ms };
}

async function waitForSessions(sessionIds: string[], timeoutMs = 20 * 60 * 1000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { rows } = await pool.query<{ id: string; status: string }>(
			`SELECT id, status FROM attendance_sessions WHERE id = ANY($1::uuid[])`,
			[sessionIds]
		);
		const terminal = rows.filter((row) => row.status === 'completed' || row.status === 'failed');
		if (terminal.length === sessionIds.length) return rows;
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	throw new Error(`timed out waiting for ${sessionIds.length} sessions`);
}

function assertResponses(
	name: string,
	submissions: Submission[],
	expectedAccepted: number,
	expectedConflict: number
) {
	const accepted = submissions.filter((result) => result.status === 202);
	const conflicts = submissions.filter((result) => result.status === 409);
	const serverErrors = submissions.filter((result) => result.status >= 500);
	const responseSummary = submissions.reduce<Record<string, number>>((summary, result) => {
		const key = `${result.status}:${result.body?.error || result.body?.raw || 'no-body'}`;
		summary[key] = (summary[key] || 0) + 1;
		return summary;
	}, {});
	if (accepted.length !== expectedAccepted) {
		throw new Error(
			`${name}: expected ${expectedAccepted} accepted, received ${accepted.length}; ${JSON.stringify(responseSummary)}`
		);
	}
	if (conflicts.length !== expectedConflict) {
		throw new Error(
			`${name}: expected ${expectedConflict} conflicts, received ${conflicts.length}; ${JSON.stringify(responseSummary)}`
		);
	}
	if (serverErrors.length) {
		throw new Error(`${name}: received ${serverErrors.length} server errors`);
	}
	return accepted;
}

async function runProfile(name: string, pumps: Pump[], corpus: any[]) {
	const submissions = await Promise.all(
		pumps.map((pump, index) =>
			submit(
				pump,
				uniqueJpeg(corpus[index].bytes, `${name}-${index}`),
				`${name}-${corpus[index].entry.filename}`
			)
		)
	);
	const accepted = assertResponses(name, submissions, pumps.length, 0);
	const terminal = await waitForSessions(accepted.map((result) => result.body.session_id));
	return {
		name,
		requests: submissions.length,
		accepted: accepted.length,
		conflicts: 0,
		server_errors: 0,
		p50_submit_ms: Math.round(
			percentile(
				submissions.map((result) => result.elapsed_ms),
				0.5
			)
		),
		p95_submit_ms: Math.round(
			percentile(
				submissions.map((result) => result.elapsed_ms),
				0.95
			)
		),
		max_submit_ms: Math.round(Math.max(...submissions.map((result) => result.elapsed_ms))),
		completed: terminal.filter((row) => row.status === 'completed').length,
		failed: terminal.filter((row) => row.status === 'failed').length,
		session_ids: accepted.map((result) => result.body.session_id)
	};
}

async function main() {
	const extractionRun =
		process.env.E2E_RUN_ID ||
		(
			await fs.readFile(path.join(ROOT, 'test-output', 'attendance-e2e', 'latest-run.txt'), 'utf8')
		).trim();
	const runDir = path.join(ROOT, 'test-output', 'attendance-e2e', extractionRun);
	await fs.mkdir(runDir, { recursive: true });
	const runTag = new Date().toISOString().replace(/\D/g, '').slice(6, 14);
	const hierarchy = await createHierarchy(runTag);
	const corpus = await loadCorpus();
	const profiles: any[] = [];

	if (PROFILE === 'all' || PROFILE === 'same-pump') {
		const submissions = await Promise.all(
			corpus.map((photo, index) =>
				submit(
					hierarchy.samePump,
					uniqueJpeg(photo.bytes, `same-pump-${index}`),
					`same-pump-${photo.entry.filename}`
				)
			)
		);
		const accepted = assertResponses('same-pump', submissions, 1, 19);
		const terminal = await waitForSessions(accepted.map((result) => result.body.session_id));
		const counts = await pool.query<{ sessions: string; jobs: string }>(
			`SELECT
			   (SELECT count(*) FROM attendance_sessions WHERE pump_id = $1)::text AS sessions,
			   (SELECT count(*) FROM attendance_jobs j
			      JOIN attendance_sessions s ON s.id = j.session_id
			      WHERE s.pump_id = $1)::text AS jobs`,
			[hierarchy.samePump.id]
		);
		if (counts.rows[0].sessions !== '1' || counts.rows[0].jobs !== '1') {
			throw new Error(`same-pump left unexpected rows: ${JSON.stringify(counts.rows[0])}`);
		}
		profiles.push({
			name: 'same-pump',
			requests: submissions.length,
			accepted: accepted.length,
			conflicts: submissions.filter((result) => result.status === 409).length,
			server_errors: submissions.filter((result) => result.status >= 500).length,
			p50_submit_ms: Math.round(
				percentile(
					submissions.map((result) => result.elapsed_ms),
					0.5
				)
			),
			p95_submit_ms: Math.round(
				percentile(
					submissions.map((result) => result.elapsed_ms),
					0.95
				)
			),
			max_submit_ms: Math.round(Math.max(...submissions.map((result) => result.elapsed_ms))),
			completed: terminal.filter((row) => row.status === 'completed').length,
			failed: terminal.filter((row) => row.status === 'failed').length,
			session_ids: accepted.map((result) => result.body.session_id)
		});
	}

	if (PROFILE === 'all' || PROFILE === 'independent') {
		profiles.push(await runProfile('independent-areas', hierarchy.independentPumps, corpus));
	}
	if (PROFILE === 'all' || PROFILE === 'same-area') {
		profiles.push(await runProfile('same-area', hierarchy.sameAreaPumps, corpus));
	}

	const sessionIds = profiles.flatMap((profile) => profile.session_ids);
	const audit = await pool.query(
		`SELECT s.id, s.pump_id, p.pump_code, s.session_type, s.status, s.pairing_status,
		        s.submitted_at, s.processed_at, j.status AS job_status, j.request_id,
		        j.attempts, j.last_error,
		        count(DISTINCT dpa.id)::int AS attendance_rows,
		        count(DISTINCT ff.id)::int AS fraud_flags
		 FROM attendance_sessions s
		 JOIN pumps p ON p.id = s.pump_id
		 JOIN attendance_jobs j ON j.session_id = s.id
		 LEFT JOIN daily_person_attendance dpa
		   ON dpa.pump_id = s.pump_id AND dpa.session_date = s.session_date
		 LEFT JOIN fraud_flags ff ON ff.session_id = s.id
		 WHERE s.id = ANY($1::uuid[])
		 GROUP BY s.id, p.pump_code, j.status, j.request_id, j.attempts, j.last_error
		 ORDER BY s.submitted_at`,
		[sessionIds]
	);
	const duplicateJobs = await pool.query(
		`SELECT session_id FROM attendance_jobs
		 WHERE session_id = ANY($1::uuid[])
		 GROUP BY session_id HAVING count(*) > 1`,
		[sessionIds]
	);
	await fs.writeFile(
		path.join(runDir, 'queue-timings.json'),
		JSON.stringify({ extraction_run_id: extractionRun, database_tag: runTag, profiles }, null, 2) +
			'\n'
	);
	await fs.writeFile(
		path.join(runDir, 'attendance-audit.json'),
		JSON.stringify(audit.rows, null, 2) + '\n'
	);

	const failed = audit.rows.filter(
		(row: any) => row.status !== 'completed' || row.job_status !== 'done'
	);
	const notExactlyOnce = audit.rows.filter((row: any) => row.attempts !== 1);
	const slow = profiles.filter((profile) => profile.p95_submit_ms >= 1000);
	console.log(JSON.stringify({ extractionRun, runTag, profiles, failed: failed.length }, null, 2));
	if (failed.length) throw new Error(`${failed.length} sessions/jobs did not finish successfully`);
	if (notExactlyOnce.length)
		throw new Error(`${notExactlyOnce.length} jobs were not claimed exactly once`);
	if (duplicateJobs.rowCount)
		throw new Error(`${duplicateJobs.rowCount} sessions have duplicate jobs`);
	if (slow.length)
		throw new Error(`submission p95 exceeded 1 second: ${slow.map((row) => row.name)}`);
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await pool.end();
	});
