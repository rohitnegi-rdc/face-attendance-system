import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { parse } from 'csv-parse/sync';

const { Pool } = pg;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIO_PATH = argument('--scenario') || 'eval/scenarios/attendance-50-concurrent.json';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:3001';
const DATABASE_URL =
	process.env.DATABASE_URL || 'postgres://attendance:attendance@127.0.0.1:5433/attendance';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const BASELINE_DIR = path.join(
	ROOT,
	'test-output',
	'evaluations',
	'20260811-151623__golden-small-group__golden-small-groups-v1'
);
const pool = new Pool({ connectionString: DATABASE_URL, max: 20 });
let importerPool: pg.Pool | null = null;
let requestOrigin = process.env.REQUEST_ORIGIN || APP_URL;

type GoldenCase = {
	case_id: string;
	scenario: string;
	attendance_date: string;
	morning_photo: string;
	evening_photo: string;
	ground_truth: string;
	morning_expected_faces: number;
	evening_expected_faces: number;
	expected_absent_workers: string[];
	fraud_group_id: string | null;
};
type Pump = {
	id: string;
	pump_code: string;
	login_email: string;
	area_id: string;
	area_name: string;
};
type Assignment = GoldenCase & { agent_id: string; pump: Pump };
type RequestResult = {
	wave: 'morning' | 'evening';
	agent_id: string;
	case_id: string;
	scenario: string;
	pump_id: string;
	pump_code: string;
	started_at: string;
	finished_at: string;
	start_offset_ms: number;
	api_latency_ms: number;
	http_status: number;
	request_id: string | null;
	session_id: string | null;
	error: string | null;
};

type ResourceSample = {
	at: string;
	elapsed_ms: number;
	service: string;
	container: string;
	cpu_percent: number | null;
	memory_used_mb: number | null;
	memory_limit_mb: number | null;
	memory_percent: number | null;
};

function argument(name: string) {
	const direct = process.argv.find((value) => value.startsWith(`${name}=`));
	if (direct) return direct.slice(name.length + 1);
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function stamp() {
	const date = new Date();
	const p = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values: number[], point: number) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * point) - 1))];
}

function stats(values: number[]) {
	const usable = values.filter(Number.isFinite);
	if (!usable.length)
		return {
			count: 0,
			min: null,
			mean: null,
			p50: null,
			p90: null,
			p95: null,
			p99: null,
			max: null
		};
	const round = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);
	return {
		count: usable.length,
		min: round(Math.min(...usable)),
		mean: round(usable.reduce((sum, value) => sum + value, 0) / usable.length),
		p50: round(percentile(usable, 0.5)),
		p90: round(percentile(usable, 0.9)),
		p95: round(percentile(usable, 0.95)),
		p99: round(percentile(usable, 0.99)),
		max: round(Math.max(...usable))
	};
}

function dockerNumber(value: string | undefined) {
	const match = String(value || '').match(/([0-9.]+)/);
	return match ? Number(match[1]) : null;
}

function memoryMegabytes(value: string | undefined) {
	const match = String(value || '')
		.trim()
		.match(/([0-9.]+)\s*([KMGT]?i?B)/i);
	if (!match) return null;
	const units: Record<string, number> = {
		B: 1 / (1024 * 1024),
		KB: 1 / 1024,
		KIB: 1 / 1024,
		MB: 1,
		MIB: 1,
		GB: 1024,
		GIB: 1024,
		TB: 1024 * 1024,
		TIB: 1024 * 1024
	};
	return Number(match[1]) * (units[match[2].toUpperCase()] || 1);
}

function summarizeResources(samples: ResourceSample[]) {
	return Object.fromEntries(
		['app', 'worker', 'ai-service', 'postgres'].map((service) => {
			const rows = samples.filter((sample) => sample.service === service);
			return [
				service,
				{
					samples: rows.length,
					cpu_percent: stats(rows.map((row) => row.cpu_percent ?? NaN)),
					memory_used_mb: stats(rows.map((row) => row.memory_used_mb ?? NaN)),
					memory_percent: stats(rows.map((row) => row.memory_percent ?? NaN))
				}
			];
		})
	);
}

function startResourceMonitor(intervalMs = 1_000) {
	const startedAt = Date.now();
	const samples: ResourceSample[] = [];
	let stopped = false;
	const task = (async () => {
		while (!stopped) {
			try {
				const serviceIds = new Map<string, string>();
				for (const service of ['app', 'worker', 'ai-service', 'postgres']) {
					const id = execFileSync('docker', ['compose', 'ps', '-q', service], {
						cwd: ROOT,
						encoding: 'utf8'
					}).trim();
					if (id) serviceIds.set(id.slice(0, 12), service);
				}
				if (serviceIds.size) {
					const output = execFileSync(
						'docker',
						['stats', '--no-stream', '--format', '{{json .}}', ...serviceIds.keys()],
						{ cwd: ROOT, encoding: 'utf8' }
					);
					for (const line of output.split(/\r?\n/).filter(Boolean)) {
						const row = JSON.parse(line);
						const usedAndLimit = String(row.MemUsage || '').split('/');
						samples.push({
							at: new Date().toISOString(),
							elapsed_ms: Date.now() - startedAt,
							service: serviceIds.get(row.ID) || row.Name,
							container: row.Name,
							cpu_percent: dockerNumber(row.CPUPerc),
							memory_used_mb: memoryMegabytes(usedAndLimit[0]),
							memory_limit_mb: memoryMegabytes(usedAndLimit[1]),
							memory_percent: dockerNumber(row.MemPerc)
						});
					}
				}
			} catch {
				// The monitor is observational: a transient Docker stats failure must not abort a test.
			}
			await sleep(intervalMs);
		}
	})();
	return {
		async stop() {
			stopped = true;
			await task;
			return samples;
		}
	};
}

function csvCell(value: unknown) {
	const text = value === null || value === undefined ? '' : String(value);
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows: Record<string, unknown>[]) {
	if (!rows.length) return '';
	const columns = Object.keys(rows[0]);
	return `${columns.join(',')}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')).join('\n')}\n`;
}

function compose(...args: string[]) {
	execFileSync('docker', ['compose', ...args], { cwd: ROOT, stdio: 'inherit' });
}

function resolveRequestOrigin() {
	if (process.env.REQUEST_ORIGIN) return process.env.REQUEST_ORIGIN;
	try {
		return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'printenv', 'ORIGIN'], {
			cwd: ROOT,
			encoding: 'utf8'
		}).trim();
	} catch {
		return APP_URL;
	}
}

function cookieFor(pump: Pump) {
	const token = jwt.sign({ role: 'pump', id: pump.id, email: pump.login_email }, JWT_SECRET, {
		expiresIn: '4h'
	});
	return `session=${token}`;
}

function uniquePhoto(bytes: Buffer, runId: string, wave: string, caseId: string) {
	return Buffer.concat([
		bytes,
		Buffer.from(`\nEVAL:${runId}:${wave}:${caseId}:${crypto.randomUUID()}\n`)
	]);
}

async function writeJson(file: string, value: unknown) {
	await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendEvent(file: string, event: Record<string, unknown>) {
	await fs.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

async function healthcheck() {
	const response = await fetch(`${APP_URL}/login`, { signal: AbortSignal.timeout(10_000) });
	if (!response.ok) throw new Error(`app healthcheck returned ${response.status}`);
	await pool.query('SELECT 1');
}

async function syncRealPumpInventory(eventsFile: string) {
	process.env.DATABASE_URL = DATABASE_URL;
	const [{ importCsv }, { pool: sharedPool }] = await Promise.all([
		import('../src/lib/server/csvImport.ts'),
		import('../src/lib/server/db.ts')
	]);
	importerPool = sharedPool;
	const before = await pool.query<{ pump_code: string }>('SELECT pump_code FROM pumps');
	const beforeCodes = new Set(before.rows.map((row) => row.pump_code));
	const csvText = await fs.readFile(path.join(ROOT, 'Pump Vendor.csv'), 'utf8');
	const result = await importCsv(csvText);
	const after = await pool.query<{ id: string; pump_code: string }>(
		'SELECT id, pump_code FROM pumps'
	);
	const imported = after.rows.filter((row) => !beforeCodes.has(row.pump_code));
	await appendEvent(eventsFile, {
		type: 'inventory-sync',
		before: beforeCodes.size,
		after: after.rowCount,
		imported_real_pumps: imported.length,
		import_summary: result
	});
	return imported;
}

async function eligiblePumps() {
	const { rows } = await pool.query<Pump>(
		`SELECT p.id, p.pump_code, p.login_email, a.id AS area_id, a.name AS area_name
		 FROM pumps p
		 JOIN plants pl ON pl.id = p.plant_id
		 JOIN areas a ON a.id = pl.area_id
		 WHERE p.pump_code NOT LIKE 'E2E%'
		   AND p.pump_code NOT LIKE 'LOADTEST%'
		   AND NOT EXISTS (SELECT 1 FROM persons pe WHERE pe.pump_id = p.id)
		   AND NOT EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.pump_id = p.id)
		 ORDER BY a.name, p.pump_code`
	);
	return rows;
}

function assignPumps(cases: GoldenCase[], pumps: Pump[]): Assignment[] {
	const available = [...pumps];
	const assignments: Assignment[] = [];
	const usedAreasByDate = new Map<string, Set<string>>();
	const fraudCases = cases.filter((entry) => entry.fraud_group_id);
	const ordinaryCases = cases.filter((entry) => !entry.fraud_group_id);
	const pumpsByArea = new Map<string, Pump[]>();
	for (const pump of available)
		pumpsByArea.set(pump.area_id, [...(pumpsByArea.get(pump.area_id) || []), pump]);
	const fraudPumps = [...pumpsByArea.values()].find((group) => group.length >= fraudCases.length);
	if (!fraudPumps)
		throw new Error(`no real Area has ${fraudCases.length} unused pumps for fraud cases`);
	const reservedFraudPumps = fraudPumps.slice(0, fraudCases.length);
	for (const pump of reservedFraudPumps) available.splice(available.indexOf(pump), 1);

	for (const entry of ordinaryCases) {
		const blocked = usedAreasByDate.get(entry.attendance_date) || new Set<string>();
		const index = available.findIndex((pump) => !blocked.has(pump.area_id));
		if (index < 0) throw new Error(`cannot isolate ${entry.case_id} by date and Area`);
		const pump = available.splice(index, 1)[0];
		blocked.add(pump.area_id);
		usedAreasByDate.set(entry.attendance_date, blocked);
		assignments.push({ ...entry, agent_id: '', pump });
	}

	for (const [index, entry] of fraudCases.entries())
		assignments.push({ ...entry, agent_id: '', pump: reservedFraudPumps[index] });

	return assignments
		.sort((a, b) => a.case_id.localeCompare(b.case_id))
		.map((entry, index) => ({ ...entry, agent_id: `agent-${String(index + 1).padStart(2, '0')}` }));
}

async function submitWave(
	wave: 'morning' | 'evening',
	assignments: Assignment[],
	datasetRoot: string,
	runId: string,
	eventsFile: string
) {
	const prepared = await Promise.all(
		assignments.map(async (entry) => ({
			entry,
			bytes: uniquePhoto(
				await fs.readFile(
					path.join(datasetRoot, wave === 'morning' ? entry.morning_photo : entry.evening_photo)
				),
				runId,
				wave,
				entry.case_id
			)
		}))
	);
	const releaseWall = Date.now() + 300;
	const releaseMono = performance.now() + 300;
	await appendEvent(eventsFile, {
		type: 'barrier-ready',
		wave,
		agents: prepared.length,
		release_at: new Date(releaseWall).toISOString()
	});
	await sleep(Math.max(0, releaseWall - Date.now()));

	return Promise.all(
		prepared.map(async ({ entry, bytes }) => {
			const startedMono = performance.now();
			const startedAt = new Date();
			await appendEvent(eventsFile, {
				type: 'request-start',
				wave,
				agent_id: entry.agent_id,
				case_id: entry.case_id,
				pump_id: entry.pump.id
			});
			const form = new FormData();
			form.append(
				'photo',
				new Blob([bytes], { type: 'image/jpeg' }),
				`${entry.case_id}-${wave}.jpg`
			);
			form.append('lat', '12.9716');
			form.append('lng', '77.5946');
			let status = 0;
			let body: any = {};
			let error: string | null = null;
			try {
				const response = await fetch(`${APP_URL}/api/attendance/submit`, {
					method: 'POST',
					headers: { cookie: cookieFor(entry.pump), origin: requestOrigin },
					body: form,
					signal: AbortSignal.timeout(30_000)
				});
				status = response.status;
				const text = await response.text();
				try {
					body = JSON.parse(text);
				} catch {
					body = { raw: text };
				}
				error = response.ok ? null : body.error || body.raw || `HTTP ${status}`;
			} catch (caught: any) {
				error = String(caught?.message || caught);
			}
			const result: RequestResult = {
				wave,
				agent_id: entry.agent_id,
				case_id: entry.case_id,
				scenario: entry.scenario,
				pump_id: entry.pump.id,
				pump_code: entry.pump.pump_code,
				started_at: startedAt.toISOString(),
				finished_at: new Date().toISOString(),
				start_offset_ms: Math.round((startedMono - releaseMono) * 10) / 10,
				api_latency_ms: Math.round((performance.now() - startedMono) * 10) / 10,
				http_status: status,
				request_id: body.request_id || null,
				session_id: body.session_id || null,
				error
			};
			await appendEvent(eventsFile, { type: 'response-received', ...result });
			return result;
		})
	);
}

async function moveSessionsToGoldenDates(results: RequestResult[], assignments: Assignment[]) {
	const byCase = new Map(assignments.map((entry) => [entry.case_id, entry]));
	for (const result of results) {
		if (!result.session_id) continue;
		await pool.query('UPDATE attendance_sessions SET session_date = $1 WHERE id = $2', [
			byCase.get(result.case_id)!.attendance_date,
			result.session_id
		]);
	}
}

async function makeEveningEligible(morning: RequestResult[]) {
	const ids = morning.map((row) => row.session_id).filter(Boolean);
	await pool.query(
		`UPDATE attendance_sessions
		 SET session_date = (now() AT TIME ZONE 'Asia/Kolkata')::date,
		     submitted_at = now() - interval '2 minutes'
		 WHERE id = ANY($1::uuid[])`,
		[ids]
	);
}

async function sampleUntilTerminal(
	wave: string,
	results: RequestResult[],
	intervalMs: number,
	timeoutMs: number,
	eventsFile: string
) {
	const ids = results.map((row) => row.session_id).filter(Boolean) as string[];
	const samples: Record<string, unknown>[] = [];
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const { rows } = await pool.query(
			`SELECT count(*) FILTER (WHERE j.status='queued')::int AS queued,
		            count(*) FILTER (WHERE j.status='claimed')::int AS claimed,
		            count(*) FILTER (WHERE j.status='done')::int AS done,
		            count(*) FILTER (WHERE j.status='error')::int AS error,
		            count(*) FILTER (WHERE s.status IN ('completed','failed'))::int AS terminal
		     FROM attendance_sessions s JOIN attendance_jobs j ON j.session_id=s.id
		     WHERE s.id = ANY($1::uuid[])`,
			[ids]
		);
		const sample = { wave, elapsed_ms: Date.now() - started, ...rows[0] };
		samples.push(sample);
		await appendEvent(eventsFile, { type: 'queue-sample', ...sample });
		if (
			Number(rows[0].terminal) === ids.length &&
			Number(rows[0].queued) + Number(rows[0].claimed) === 0
		)
			return samples;
		await sleep(intervalMs);
	}
	throw new Error(`${wave} queue did not drain within ${timeoutMs} ms`);
}

async function auditSessions(requests: RequestResult[]) {
	const ids = requests.map((row) => row.session_id).filter(Boolean);
	const { rows } = await pool.query(
		`SELECT s.id AS session_id, s.pump_id, p.pump_code, s.session_type, s.session_date::text,
		        s.status AS session_status, s.submitted_at, s.processed_at, s.error_reason, s.processing_metadata,
		        j.request_id, j.status AS job_status, j.created_at, j.claimed_at, j.attempts, j.last_error,
		        round(extract(epoch FROM (j.claimed_at-j.created_at))*1000)::bigint AS queue_wait_ms,
		        round(extract(epoch FROM (s.processed_at-j.claimed_at))*1000)::bigint AS processing_ms,
		        round(extract(epoch FROM (s.processed_at-j.created_at))*1000)::bigint AS database_e2e_ms,
		        (SELECT count(*)::int FROM person_face_vectors v WHERE v.session_id=s.id) AS face_vectors,
		        (SELECT count(*)::int FROM fraud_flags f WHERE f.session_id=s.id) AS fraud_flags,
		        (SELECT count(*)::int FROM flagged_guests g WHERE g.session_id=s.id) AS unknown_faces
		 FROM attendance_sessions s
		 JOIN pumps p ON p.id=s.pump_id
		 JOIN attendance_jobs j ON j.session_id=s.id
		 WHERE s.id = ANY($1::uuid[])
		 ORDER BY j.created_at`,
		[ids]
	);
	return rows.map((row) => ({
		...row,
		processing_metadata:
			typeof row.processing_metadata === 'string'
				? JSON.parse(row.processing_metadata)
				: row.processing_metadata,
		queue_wait_ms: Number(row.queue_wait_ms),
		processing_ms: Number(row.processing_ms),
		database_e2e_ms: Number(row.database_e2e_ms)
	}));
}

function summarizeRequests(
	requests: RequestResult[],
	jobs: any[],
	samples: any[],
	startedAt: number,
	finishedAt: number
) {
	const accepted = requests.filter((row) => row.http_status === 202);
	const completed = jobs.filter(
		(row) => row.session_status === 'completed' && row.job_status === 'done'
	);
	const requestBySession = new Map(
		requests.filter((row) => row.session_id).map((row) => [row.session_id, row])
	);
	const endToEnd = jobs.map((job) => {
		const request = requestBySession.get(job.session_id);
		return request && job.processed_at
			? new Date(job.processed_at).getTime() - new Date(request.started_at).getTime()
			: NaN;
	});
	const elapsedSeconds = Math.max(0.001, (finishedAt - startedAt) / 1000);
	return {
		attempted: requests.length,
		accepted: accepted.length,
		completed: completed.length,
		failed: jobs.filter((row) => row.session_status === 'failed' || row.job_status === 'error')
			.length,
		conflicts: requests.filter((row) => row.http_status === 409).length,
		client_errors: requests.filter((row) => row.http_status >= 400 && row.http_status < 500).length,
		server_errors: requests.filter((row) => row.http_status >= 500).length,
		timeouts: requests.filter((row) => row.http_status === 0).length,
		success_rate: accepted.length ? completed.length / accepted.length : 0,
		failure_rate: accepted.length ? (accepted.length - completed.length) / accepted.length : 1,
		retried_jobs: jobs.filter((row) => Number(row.attempts) > 1).length,
		api_acceptance_ms: stats(requests.map((row) => row.api_latency_ms)),
		barrier_start_offset_ms: stats(requests.map((row) => Math.abs(row.start_offset_ms))),
		queue_wait_ms: stats(jobs.map((row) => row.queue_wait_ms)),
		processing_ms: stats(jobs.map((row) => row.processing_ms)),
		end_to_end_ms: stats(endToEnd),
		peak_queued: Math.max(0, ...samples.map((row) => Number(row.queued))),
		peak_claimed: Math.max(0, ...samples.map((row) => Number(row.claimed))),
		drain_time_ms: finishedAt - startedAt,
		throughput_sessions_per_second: Math.round((completed.length / elapsedSeconds) * 1000) / 1000
	};
}

async function copyReviewImages(assignments: Assignment[], datasetRoot: string, outputDir: string) {
	const imageDir = path.join(outputDir, 'assets', 'images');
	await fs.mkdir(imageDir, { recursive: true });
	for (const entry of assignments) {
		const caseDir = path.join(imageDir, entry.case_id);
		await fs.mkdir(caseDir, { recursive: true });
		await fs.copyFile(
			path.join(datasetRoot, entry.morning_photo),
			path.join(caseDir, 'morning.jpg')
		);
		await fs.copyFile(
			path.join(datasetRoot, entry.evening_photo),
			path.join(caseDir, 'evening.jpg')
		);
	}
}

async function captureLogs(outputDir: string, since: string) {
	await fs.mkdir(path.join(outputDir, 'logs'), { recursive: true });
	for (const service of ['app', 'worker', 'ai-service']) {
		try {
			const output = execFileSync(
				'docker',
				['compose', 'logs', '--no-color', '--since', since, service],
				{ cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
			);
			await fs.writeFile(path.join(outputDir, 'logs', `${service}.log`), output);
		} catch (error: any) {
			await fs.writeFile(
				path.join(outputDir, 'logs', `${service}.log`),
				`log capture failed: ${error.message}\n`
			);
		}
	}
}

function escapeHtml(value: unknown) {
	return String(value ?? '').replace(
		/[&<>"']/g,
		(char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
	);
}

function reportHtml(
	summary: any,
	requests: RequestResult[],
	thresholdRows: any[],
	assignments: Assignment[]
) {
	const agentCount = Number(summary.virtual_agents);
	const reportTitle = `${agentCount}-Agent Attendance Concurrency Evaluation`;
	const json = JSON.stringify({ requests }).replaceAll('<', '\\u003c');
	const thresholdJson = JSON.stringify(thresholdRows).replaceAll('<', '\\u003c');
	const card = (label: string, value: string) =>
		`<article class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
	const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
	const minutes = (value: number | null) =>
		value === null ? 'n/a' : `${(value / 60_000).toFixed(3)} min`;
	const reliabilityRows = ['morning', 'evening', 'combined']
		.map((key) => {
			const metric = summary[key];
			return `<tr><td>${key}</td><td>${metric.attempted}</td><td>${metric.accepted}</td><td>${metric.completed}</td><td>${metric.failed}</td><td>${metric.conflicts}</td><td>${metric.server_errors}</td><td>${metric.retried_jobs}</td><td>${minutes(metric.drain_time_ms)}</td></tr>`;
		})
		.join('');
	const speedRows = [
		['API acceptance', summary.combined.api_acceptance_ms],
		['Queue wait', summary.combined.queue_wait_ms],
		['Worker processing', summary.combined.processing_ms],
		['End to end', summary.combined.end_to_end_ms]
	]
		.map(
			([name, values]: any) =>
				`<tr><td>${name}</td>${['min', 'mean', 'p50', 'p90', 'p95', 'p99', 'max'].map((key) => `<td>${minutes(values[key])}</td>`).join('')}</tr>`
		)
		.join('');
	const resourceRows = Object.entries(summary.resources || {})
		.map(([service, resource]: [string, any]) => {
			const value = (stat: any, key: string, suffix: string) =>
				stat?.[key] == null ? 'n/a' : `${Number(stat[key]).toFixed(1)}${suffix}`;
			return `<tr><th>${escapeHtml(service)}</th><td>${resource.samples}</td><td>${value(resource.cpu_percent, 'mean', '%')}</td><td>${value(resource.cpu_percent, 'p95', '%')}</td><td>${value(resource.cpu_percent, 'max', '%')}</td><td>${value(resource.memory_used_mb, 'mean', ' MB')}</td><td>${value(resource.memory_used_mb, 'p95', ' MB')}</td><td>${value(resource.memory_used_mb, 'max', ' MB')}</td></tr>`;
		})
		.join('');
	const peak = Math.max(1, summary.combined.peak_queued + summary.combined.peak_claimed);
	const queueBars = summary.queue_samples
		.map(
			(sample: any) =>
				`<span class="bar" style="height:${Math.max(1, ((Number(sample.queued) + Number(sample.claimed)) / peak) * 100)}%" title="${sample.wave} ${(Number(sample.elapsed_ms) / 60_000).toFixed(3)} min: queued ${sample.queued}, claimed ${sample.claimed}"></span>`
		)
		.join('');
	const caseButtons = assignments
		.map(
			(entry) =>
				`<button class="case" data-case="${escapeHtml(entry.case_id)}"><strong>${escapeHtml(entry.case_id)}</strong><br><span>${escapeHtml(entry.scenario)} | ${escapeHtml(entry.pump.pump_code)}</span></button>`
		)
		.join('');

	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${reportTitle}</title><style>
:root{color:#162625;background:#f4f7f7;font:16px Arial,sans-serif}*{box-sizing:border-box}body{margin:0}main{max-width:1440px;margin:auto;padding:24px}h1{font-size:30px;margin:0 0 6px}h2{margin:30px 0 10px}p{color:#506463}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:20px 0}.metric{background:#fff;border:1px solid #bbbfbf;border-left:4px solid #05ad98;padding:14px}.metric span{display:block;color:#5d6b6a;font-size:13px}.metric strong{display:block;font-size:25px;margin-top:6px}.panel{background:#fff;border:1px solid #bbbfbf;padding:16px;margin:14px 0;overflow:auto}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid #d6dddd;text-align:left;white-space:nowrap}th{background:#e9eeee;position:sticky;top:0}button,select{font:inherit;padding:8px 10px;border:1px solid #878787;background:#fff}button{cursor:pointer;color:#006f62}.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.queue{height:130px;display:flex;align-items:end;gap:3px;border-bottom:1px solid #878787}.bar{flex:1;background:#05ad98;min-width:2px}.cases{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px}.case{padding:10px;text-align:left}.preview{display:none;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px}.preview.open{display:grid}.preview img{width:100%;max-height:520px;object-fit:contain;background:#eee}details summary{cursor:pointer;font-weight:bold;padding:8px}.muted{color:#667}code{background:#e9eeee;padding:2px 5px}@media(max-width:700px){main{padding:14px}.preview{grid-template-columns:1fr}}
</style></head><body><main><h1>${reportTitle}</h1><p>Run <code>${escapeHtml(summary.run_id)}</code> | ${agentCount} synchronized morning requests, then ${agentCount} synchronized evening requests | golden-small-groups-v1</p><div class="metrics">${card('Success rate', pct(summary.combined.success_rate))}${card('Failure rate', pct(summary.combined.failure_rate))}${card('API p95', minutes(summary.combined.api_acceptance_ms.p95))}${card('Queue wait p95', minutes(summary.combined.queue_wait_ms.p95))}${card('Processing p95', minutes(summary.combined.processing_ms.p95))}${card('End-to-end p95', minutes(summary.combined.end_to_end_ms.p95))}${card('Peak queued', String(summary.combined.peak_queued))}${card('Throughput', `${summary.combined.throughput_sessions_per_second}/s`)}</div><h2>Reliability</h2><div class="panel"><table><thead><tr><th>Wave</th><th>Attempted</th><th>Accepted</th><th>Completed</th><th>Failed</th><th>409</th><th>5xx</th><th>Retries</th><th>Drain</th></tr></thead><tbody>${reliabilityRows}</tbody></table></div><h2>Speed percentiles (minutes)</h2><div class="panel"><table><thead><tr><th>Metric</th><th>Min</th><th>Mean</th><th>P50</th><th>P90</th><th>P95</th><th>P99</th><th>Max</th></tr></thead><tbody>${speedRows}</tbody></table></div><h2>Container resources during this run</h2><div class="panel"><table><thead><tr><th>Service</th><th>Samples</th><th>CPU mean</th><th>CPU p95</th><th>CPU max</th><th>RAM mean</th><th>RAM p95</th><th>RAM max</th></tr></thead><tbody>${resourceRows}</tbody></table></div><h2>Accuracy by threshold</h2><div class="panel"><div class="controls"><label>Threshold <select id="threshold"></select></label><strong id="thresholdTitle"></strong></div><div id="accuracyCards" class="metrics"></div><p class="muted">Accuracy metrics are deterministic results from the same golden dataset. Concurrency metrics above come from this live application run.</p></div><h2>Queue profile</h2><div class="panel"><div class="queue">${queueBars}</div><p>Each bar is sampled queue depth. Hover for wave, elapsed minutes, queued, and claimed counts.</p></div><details class="panel" id="requestDetails"><summary>Request and queue trace (${summary.total_requests} requests, loaded on demand)</summary><div id="requestTable"></div></details><h2>Image review</h2><div class="panel"><p>Images are not loaded until a case is selected.</p><div class="cases">${caseButtons}</div><div id="preview" class="preview"><figure><img id="morningImage" alt="Morning group"><figcaption>Morning input</figcaption></figure><figure><img id="eveningImage" alt="Evening group"><figcaption>Evening input</figcaption></figure></div></div><h2>Artifacts</h2><div class="panel"><a href="requests.csv">Requests CSV</a> | <a href="queue-jobs.csv">Queue jobs CSV</a> | <a href="resource-samples.csv">Resource samples CSV</a> | <a href="accuracy-by-threshold.csv">Threshold CSV</a> | <a href="events.jsonl">JSONL events</a> | <a href="logs/">Service logs</a></div></main><script>
const DATA=${json},THRESHOLDS=${thresholdJson},select=document.querySelector('#threshold');THRESHOLDS.forEach(r=>{const o=document.createElement('option');o.value=r.threshold;o.textContent=r.threshold;if(String(r.threshold)==='0.3')o.selected=true;select.append(o)});const percent=v=>v===''||v==null?'n/a':(Number(v)*100).toFixed(1)+'%';function renderThreshold(){const r=THRESHOLDS.find(x=>String(x.threshold)===select.value);document.querySelector('#thresholdTitle').textContent='Threshold '+r.threshold;const values=[['Attendance accuracy',percent(r.attendance_accuracy)],['Pair precision',percent(r.pair_precision)],['Pair recall',percent(r.pair_recall)],['Pair F1',Number(r.pair_f1).toFixed(4)],['False match',percent(r.pair_false_match_rate)],['False non-match',percent(r.pair_false_non_match_rate)],['False absent',percent(r.false_absent_rate)],['False present',percent(r.false_present_rate)],['Fraud recall',percent(r.fraud_duplicate_recall)]];document.querySelector('#accuracyCards').innerHTML=values.map(v=>'<article class="metric"><span>'+v[0]+'</span><strong>'+v[1]+'</strong></article>').join('')}select.addEventListener('change',renderThreshold);renderThreshold();let rendered=false;document.querySelector('#requestDetails').addEventListener('toggle',e=>{if(!e.target.open||rendered)return;rendered=true;const rows=[...DATA.requests].sort((a,b)=>(a.http_status===202)-(b.http_status===202)||b.api_latency_ms-a.api_latency_ms);document.querySelector('#requestTable').innerHTML='<table><thead><tr><th>Wave</th><th>Agent</th><th>Case</th><th>Pump</th><th>HTTP</th><th>API min</th><th>Request</th><th>Session</th><th>Error</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+r.wave+'</td><td>'+r.agent_id+'</td><td>'+r.case_id+'</td><td>'+r.pump_code+'</td><td>'+r.http_status+'</td><td>'+(Number(r.api_latency_ms)/60000).toFixed(3)+'</td><td>'+r.request_id+'</td><td>'+r.session_id+'</td><td>'+(r.error||'')+'</td></tr>').join('')+'</tbody></table>'});document.querySelectorAll('.case').forEach(button=>button.addEventListener('click',()=>{const id=button.dataset.case;document.querySelector('#morningImage').src='assets/images/'+id+'/morning.jpg';document.querySelector('#eveningImage').src='assets/images/'+id+'/evening.jpg';document.querySelector('#preview').classList.add('open');document.querySelector('#preview').scrollIntoView({behavior:'smooth',block:'nearest'})}));
</script></body></html>`;
}

async function regenerateReport(runId: string) {
	const safeRunId = path.basename(runId);
	if (safeRunId !== runId) throw new Error('report run must be a run ID, not a path');
	const outputDir = path.join(ROOT, 'test-output', 'load-evaluations', safeRunId);
	const summary = JSON.parse(await fs.readFile(path.join(outputDir, 'summary.json'), 'utf8'));
	const requestRows = parse(await fs.readFile(path.join(outputDir, 'requests.csv'), 'utf8'), {
		columns: true,
		skip_empty_lines: true
	}).map((row: any) => ({
		...row,
		http_status: Number(row.http_status),
		api_latency_ms: Number(row.api_latency_ms),
		start_offset_ms: Number(row.start_offset_ms)
	})) as RequestResult[];
	const thresholdRows = parse(
		await fs.readFile(path.join(outputDir, 'accuracy-by-threshold.csv'), 'utf8'),
		{ columns: true, skip_empty_lines: true }
	);
	const runConfig = JSON.parse(await fs.readFile(path.join(outputDir, 'run-config.json'), 'utf8'));
	const html = reportHtml(summary, requestRows, thresholdRows, runConfig.assignments);
	const namedReport = `attendance-${summary.virtual_agents}-agent-concurrency-report.html`;
	await fs.writeFile(path.join(outputDir, 'index.html'), html);
	await fs.writeFile(path.join(outputDir, namedReport), html);
	console.log(`Regenerated ${path.join(outputDir, namedReport)}`);
}

async function cleanupRun(runId: string) {
	const safeRunId = path.basename(runId);
	if (safeRunId !== runId || !/^\d{8}-\d{6}__attendance-\d+-agents__/.test(runId))
		throw new Error('cleanup requires a valid attendance evaluation run ID');
	const outputDir = path.join(ROOT, 'test-output', 'load-evaluations', safeRunId);
	const requestRows = parse(await fs.readFile(path.join(outputDir, 'requests.csv'), 'utf8'), {
		columns: true,
		skip_empty_lines: true
	});
	const runConfig = JSON.parse(await fs.readFile(path.join(outputDir, 'run-config.json'), 'utf8'));
	const sessionIds = requestRows.map((row: any) => row.session_id).filter(Boolean);
	const pumpIds = runConfig.assignments.map((entry: Assignment) => entry.pump.id);
	if (!sessionIds.length || !pumpIds.length) throw new Error('run has no owned records to clean');
	const personResult = await pool.query<{ person_id: string }>(
		'SELECT DISTINCT person_id FROM person_face_vectors WHERE session_id = ANY($1::uuid[])',
		[sessionIds]
	);
	const personIds = personResult.rows.map((row) => row.person_id);

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(
			'UPDATE attendance_sessions SET paired_session_id=NULL WHERE id=ANY($1::uuid[]) OR paired_session_id=ANY($1::uuid[])',
			[sessionIds]
		);
		await client.query(
			'DELETE FROM fraud_flags WHERE session_id=ANY($1::uuid[]) OR matched_session_id=ANY($1::uuid[])',
			[sessionIds]
		);
		await client.query('DELETE FROM attendance_review_flags WHERE session_id=ANY($1::uuid[])', [
			sessionIds
		]);
		await client.query('DELETE FROM flagged_guests WHERE session_id=ANY($1::uuid[])', [sessionIds]);
		await client.query('DELETE FROM attendance_face_evidence WHERE session_id=ANY($1::uuid[])', [
			sessionIds
		]);
		await client.query(
			'DELETE FROM attendance_rollup_finalizations WHERE session_id=ANY($1::uuid[])',
			[sessionIds]
		);
		await client.query('DELETE FROM attendance_jobs WHERE session_id=ANY($1::uuid[])', [
			sessionIds
		]);
		await client.query('DELETE FROM person_face_vectors WHERE session_id=ANY($1::uuid[])', [
			sessionIds
		]);
		await client.query('DELETE FROM daily_person_attendance WHERE pump_id=ANY($1::uuid[])', [
			pumpIds
		]);
		if (personIds.length) {
			await client.query('DELETE FROM person_attendance_yearly WHERE person_id=ANY($1::uuid[])', [
				personIds
			]);
		}
		await client.query('DELETE FROM attendance_sessions WHERE id=ANY($1::uuid[])', [sessionIds]);
		if (personIds.length) {
			await client.query(
				'DELETE FROM persons p WHERE p.id=ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM person_face_vectors v WHERE v.person_id=p.id)',
				[personIds]
			);
		}
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
	await writeJson(path.join(outputDir, 'cleanup.json'), {
		cleaned_at: new Date().toISOString(),
		sessions_deleted: sessionIds.length,
		generated_people_deleted: personIds.length,
		pumps_preserved: pumpIds.length
	});
	console.log(`Cleaned run-owned records for ${runId}; real pumps were preserved`);
}

async function main() {
	const cleanupRunId = argument('--cleanup-run');
	if (cleanupRunId) {
		await cleanupRun(cleanupRunId);
		await pool.end();
		return;
	}
	const reportRun = argument('--report-run');
	if (reportRun) {
		await regenerateReport(reportRun);
		await pool.end();
		return;
	}
	const scenario = JSON.parse(await fs.readFile(path.resolve(ROOT, SCENARIO_PATH), 'utf8'));
	const manifestPath = path.resolve(ROOT, scenario.dataset.manifest);
	const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
	const agentCount = Number(argument('--agents') || scenario.load.virtual_agents);
	const capacityProfile = argument('--profile') || process.env.BENCHMARK_PROFILE || 'default';
	if (!Number.isInteger(agentCount) || agentCount < 1 || agentCount > scenario.dataset.case_count)
		throw new Error(`agents must be an integer from 1 to ${scenario.dataset.case_count}`);
	const cases = manifest.cases.slice(0, agentCount) as GoldenCase[];
	if (cases.length !== agentCount)
		throw new Error(`expected ${agentCount} golden cases, found ${cases.length}`);
	if (!APP_URL.includes('127.0.0.1') && !APP_URL.includes('localhost'))
		throw new Error('refusing to run against a non-local app URL');

	const runId = `${stamp()}__attendance-${agentCount}-agents__golden-small-groups-v1__${capacityProfile.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
	const outputDir = path.join(ROOT, scenario.report.output_root, runId);
	const eventsFile = path.join(outputDir, 'events.jsonl');
	await fs.mkdir(outputDir, { recursive: true });
	await fs.writeFile(eventsFile, '');
	const runStartedIso = new Date().toISOString();
	await appendEvent(eventsFile, {
		type: 'run-start',
		run_id: runId,
		scenario: scenario.scenario_id
	});

	await healthcheck();
	requestOrigin = resolveRequestOrigin();
	const imported = await syncRealPumpInventory(eventsFile);
	const pumps = await eligiblePumps();
	if (pumps.length < agentCount)
		throw new Error(`need ${agentCount} clean real pumps; only ${pumps.length} are eligible`);
	const assignments = assignPumps(cases, pumps);
	await writeJson(path.join(outputDir, 'run-config.json'), {
		run_id: runId,
		scenario,
		assignments,
		imported_real_pumps: imported
	});
	await copyReviewImages(assignments, path.dirname(manifestPath), outputDir);

	let workerStopped = false;
	const resourceMonitor = startResourceMonitor();
	const allRequests: RequestResult[] = [];
	const allSamples: any[] = [];
	const waveTimings: Record<string, { start: number; end: number }> = {};
	let resourceSamples: ResourceSample[] = [];
	try {
		compose('stop', 'worker');
		workerStopped = true;
		waveTimings.morning = { start: Date.now(), end: 0 };
		const morning = await submitWave(
			'morning',
			assignments,
			path.dirname(manifestPath),
			runId,
			eventsFile
		);
		allRequests.push(...morning);
		if (morning.some((row) => row.http_status !== 202))
			throw new Error('not all morning requests were accepted');
		await moveSessionsToGoldenDates(morning, assignments);
		compose('start', 'worker');
		workerStopped = false;
		allSamples.push(
			...(await sampleUntilTerminal(
				'morning',
				morning,
				scenario.load.queue_sample_interval_ms,
				scenario.load.session_timeout_ms,
				eventsFile
			))
		);
		waveTimings.morning.end = Date.now();

		compose('stop', 'worker');
		workerStopped = true;
		await makeEveningEligible(morning);
		waveTimings.evening = { start: Date.now(), end: 0 };
		const evening = await submitWave(
			'evening',
			assignments,
			path.dirname(manifestPath),
			runId,
			eventsFile
		);
		allRequests.push(...evening);
		if (evening.some((row) => row.http_status !== 202))
			throw new Error('not all evening requests were accepted');
		await moveSessionsToGoldenDates([...morning, ...evening], assignments);
		compose('start', 'worker');
		workerStopped = false;
		allSamples.push(
			...(await sampleUntilTerminal(
				'evening',
				evening,
				scenario.load.queue_sample_interval_ms,
				scenario.load.session_timeout_ms,
				eventsFile
			))
		);
		waveTimings.evening.end = Date.now();
	} finally {
		if (workerStopped) compose('start', 'worker');
		resourceSamples = await resourceMonitor.stop();
	}

	const jobs = await auditSessions(allRequests);
	const morningRequests = allRequests.filter((row) => row.wave === 'morning');
	const eveningRequests = allRequests.filter((row) => row.wave === 'evening');
	const morningIds = new Set(morningRequests.map((row) => row.session_id));
	const eveningIds = new Set(eveningRequests.map((row) => row.session_id));
	const morningJobs = jobs.filter((row) => morningIds.has(row.session_id));
	const eveningJobs = jobs.filter((row) => eveningIds.has(row.session_id));
	const baselineThresholdCsv = await fs.readFile(
		path.join(BASELINE_DIR, 'threshold-sweep.csv'),
		'utf8'
	);
	const thresholdRows = parse(baselineThresholdCsv, { columns: true, skip_empty_lines: true });
	await fs.writeFile(path.join(outputDir, 'accuracy-by-threshold.csv'), baselineThresholdCsv);
	await fs.copyFile(
		path.join(BASELINE_DIR, 'metrics.json'),
		path.join(outputDir, 'accuracy-baseline.json')
	);

	const summary = {
		run_id: runId,
		started_at: runStartedIso,
		finished_at: new Date().toISOString(),
		app_url: APP_URL,
		virtual_agents: agentCount,
		capacity_profile: {
			name: capacityProfile,
			ai_service_workers: Number(process.env.AI_SERVICE_WORKERS || 2),
			worker_batch_size: Number(process.env.WORKER_BATCH_SIZE || 4),
			max_active_attendance_jobs: Number(process.env.MAX_ACTIVE_ATTENDANCE_JOBS || 30),
			ai_max_image_long_side: Number(process.env.AI_MAX_IMAGE_LONG_SIDE || 1920)
		},
		total_requests: agentCount * 2,
		application_threshold: Number(process.env.FACE_MATCH_THRESHOLD || 0.3),
		morning: summarizeRequests(
			morningRequests,
			morningJobs,
			allSamples.filter((row) => row.wave === 'morning'),
			waveTimings.morning.start,
			waveTimings.morning.end
		),
		evening: summarizeRequests(
			eveningRequests,
			eveningJobs,
			allSamples.filter((row) => row.wave === 'evening'),
			waveTimings.evening.start,
			waveTimings.evening.end
		),
		combined: summarizeRequests(
			allRequests,
			jobs,
			allSamples,
			waveTimings.morning.start,
			waveTimings.evening.end
		),
		queue_samples: allSamples,
		resources: summarizeResources(resourceSamples),
		accuracy_source: path.relative(ROOT, BASELINE_DIR).replaceAll('\\', '/'),
		notes: [
			'Accuracy threshold metrics are reused from the deterministic golden dataset evaluation.',
			'Queue wait includes the intentional worker-paused barrier/setup interval.',
			'Job claimed_at records the latest claim when a retry occurs.'
		]
	};
	await writeJson(path.join(outputDir, 'summary.json'), summary);
	await fs.writeFile(path.join(outputDir, 'requests.csv'), toCsv(allRequests));
	await fs.writeFile(path.join(outputDir, 'queue-jobs.csv'), toCsv(jobs));
	await fs.writeFile(path.join(outputDir, 'queue-samples.csv'), toCsv(allSamples));
	await fs.writeFile(path.join(outputDir, 'resource-samples.csv'), toCsv(resourceSamples));
	const html = reportHtml(summary, allRequests, thresholdRows, assignments);
	const namedReport = `attendance-${agentCount}-agent-concurrency-report.html`;
	await fs.writeFile(path.join(outputDir, 'index.html'), html);
	await fs.writeFile(path.join(outputDir, namedReport), html);
	await captureLogs(outputDir, runStartedIso);
	await fs.writeFile(path.join(ROOT, scenario.report.output_root, 'latest-run.txt'), `${runId}\n`);
	await appendEvent(eventsFile, { type: 'run-complete', run_id: runId, output: outputDir });
	console.log(
		JSON.stringify(
			{ run_id: runId, report: path.join(outputDir, 'index.html'), combined: summary.combined },
			null,
			2
		)
	);
	await pool.end();
	await importerPool?.end();
}

main().catch(async (error) => {
	console.error(error);
	await pool.end().catch(() => {});
	await importerPool?.end().catch(() => {});
	process.exitCode = 1;
});
