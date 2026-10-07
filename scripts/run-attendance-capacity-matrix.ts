import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(root, 'test-output', 'load-evaluations');
const counts = (argument('--agents') || '10,20,30,40,50')
	.split(',')
	.map(Number)
	.filter((value) => Number.isInteger(value) && value >= 1 && value <= 50);
const resume = process.argv.includes('--resume');

const profiles = [
	{ name: 'baseline-2ai-4batch', aiWorkers: '2', workerBatch: '4' },
	{ name: 'scaled-4ai-8batch', aiWorkers: '4', workerBatch: '8' },
	{ name: 'scaled-6ai-12batch', aiWorkers: '6', workerBatch: '12' }
];

function argument(name: string) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function stamp() {
	return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
	const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env, shell: false });
	if (result.status !== 0)
		throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
}

async function latestRun(profile: string, agents: number) {
	const entries = await fs.readdir(outputRoot, { withFileTypes: true });
	for (const entry of entries
		.filter((item) => item.isDirectory())
		.sort((a, b) => b.name.localeCompare(a.name))) {
		try {
			const summary = JSON.parse(
				await fs.readFile(path.join(outputRoot, entry.name, 'summary.json'), 'utf8')
			);
			if (summary.virtual_agents === agents && summary.capacity_profile?.name === profile)
				return { runId: entry.name, summary };
		} catch {
			// Ignore incomplete output folders.
		}
	}
	throw new Error(`could not locate ${profile} ${agents}-agent run`);
}

function minutes(value: number | null | undefined) {
	return value == null ? 'n/a' : (value / 60_000).toFixed(3);
}

function resource(summary: any, service: string, metric: string) {
	const value = summary.resources?.[service]?.[metric]?.p95;
	return value == null ? 'n/a' : Number(value).toFixed(1);
}

function row(result: { runId: string; summary: any }) {
	const { runId, summary } = result;
	return {
		profile: summary.capacity_profile.name,
		ai_workers: summary.capacity_profile.ai_service_workers,
		worker_batch: summary.capacity_profile.worker_batch_size,
		agents_per_wave: summary.virtual_agents,
		success_percent: (summary.combined.success_rate * 100).toFixed(1),
		failed_sessions: summary.combined.failed,
		retried_jobs: summary.combined.retried_jobs,
		queue_p95_min: minutes(summary.combined.queue_wait_ms.p95),
		processing_p95_min: minutes(summary.combined.processing_ms.p95),
		e2e_p95_min: minutes(summary.combined.end_to_end_ms.p95),
		drain_min: minutes(summary.combined.drain_time_ms),
		throughput_per_second: summary.combined.throughput_sessions_per_second,
		ai_cpu_p95_percent: resource(summary, 'ai-service', 'cpu_percent'),
		ai_ram_p95_mb: resource(summary, 'ai-service', 'memory_used_mb'),
		worker_cpu_p95_percent: resource(summary, 'worker', 'cpu_percent'),
		worker_ram_p95_mb: resource(summary, 'worker', 'memory_used_mb'),
		run_id: runId
	};
}

function escape(value: unknown) {
	return String(value ?? '').replace(
		/[&<>"']/g,
		(character) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
	);
}

function reportHtml(rows: ReturnType<typeof row>[], matrixId: string) {
	const body = rows
		.map(
			(item) =>
				`<tr><th>${escape(item.profile)}</th><td>${item.ai_workers}</td><td>${item.worker_batch}</td><td>${item.agents_per_wave}</td><td>${item.success_percent}%</td><td>${item.failed_sessions}</td><td>${item.retried_jobs}</td><td>${item.queue_p95_min}</td><td>${item.processing_p95_min}</td><td>${item.e2e_p95_min}</td><td>${item.drain_min}</td><td>${item.throughput_per_second}</td><td>${item.ai_cpu_p95_percent}%</td><td>${item.ai_ram_p95_mb}</td><td>${item.worker_cpu_p95_percent}%</td><td>${item.worker_ram_p95_mb}</td><td><a href="../${item.run_id}/index.html">Open</a></td></tr>`
		)
		.join('');
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Attendance capacity comparison</title><style>:root{font:16px Arial,sans-serif;color:#162625;background:#f4f7f7}*{box-sizing:border-box}body{margin:0}main{max-width:1800px;margin:auto;padding:24px}.panel{background:#fff;border:1px solid #bcc6c5;margin:18px 0;padding:16px;overflow:auto}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #d5dddd;padding:10px;text-align:right;white-space:nowrap}thead th{background:#e8eeee;position:sticky;top:0}tbody th{text-align:left}strong,a{color:#007c6e}code{background:#e8eeee;padding:2px 5px}@media(max-width:900px){main{padding:14px}}</style></head><body><main><h1>Attendance capacity comparison</h1><p>Matrix <code>${escape(matrixId)}</code>. Every cell runs synchronized morning and evening waves against the same golden group-photo dataset. CPU and RAM are Docker samples recorded during each run.</p><section class="panel"><table><thead><tr><th>Profile</th><th>AI workers</th><th>Worker batch</th><th>Agents / wave</th><th>Success</th><th>Failed</th><th>Retries</th><th>Queue p95 min</th><th>Processing p95 min</th><th>E2E p95 min</th><th>Drain min</th><th>Throughput / sec</th><th>AI CPU p95</th><th>AI RAM p95 MB</th><th>Worker CPU p95</th><th>Worker RAM p95 MB</th><th>Detail</th></tr></thead><tbody>${body}</tbody></table></section><section class="panel"><h2>Decision rule</h2><p>Prefer the profile with <strong>zero failures</strong>, acceptable AI CPU/RAM headroom, and the lowest p95 queue and end-to-end time at the expected production burst. A profile with lower latency but sustained CPU near saturation has little room for real-world variance.</p><p>The database queue keeps uploads durable. <strong>MAX_ACTIVE_ATTENDANCE_JOBS=30</strong> prevents more than 30 jobs from being claimed for active processing, while uploads above that number wait safely in FIFO order.</p></section></main></body></html>`;
}

async function main() {
	if (!counts.length) throw new Error('provide at least one agent count between 1 and 50');
	const rows: ReturnType<typeof row>[] = [];
	for (const profile of profiles) {
		const env = {
			...process.env,
			AI_SERVICE_WORKERS: profile.aiWorkers,
			WORKER_BATCH_SIZE: profile.workerBatch,
			BENCHMARK_PROFILE: profile.name
		};
		run(
			'docker',
			['compose', 'up', '-d', '--force-recreate', '--no-deps', 'ai-service', 'worker'],
			env
		);
		for (const agents of counts) {
			let result: { runId: string; summary: any } | null = null;
			if (resume) {
				try {
					result = await latestRun(profile.name, agents);
				} catch {
					// This cell has not been run yet.
				}
			}
			if (!result) {
				run(
					process.execPath,
					[
						path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
						path.join(root, 'scripts', 'run-attendance-concurrency-eval.ts'),
						'--agents',
						String(agents),
						'--profile',
						profile.name
					],
					env
				);
				result = await latestRun(profile.name, agents);
			}
			rows.push(row(result));
			if (
				!(await fs
					.stat(path.join(outputRoot, result.runId, 'cleanup.json'))
					.then(() => true)
					.catch(() => false))
			) {
				run(
					process.execPath,
					[
						path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
						path.join(root, 'scripts', 'run-attendance-concurrency-eval.ts'),
						'--cleanup-run',
						result.runId
					],
					env
				);
			}
		}
	}
	const matrixId = `${stamp()}__attendance-capacity-matrix__2-4__4-8__6-12`;
	const outputDir = path.join(outputRoot, matrixId);
	await fs.mkdir(outputDir, { recursive: true });
	await fs.writeFile(path.join(outputDir, 'comparison.json'), `${JSON.stringify(rows, null, 2)}\n`);
	const headers = Object.keys(rows[0]);
	await fs.writeFile(
		path.join(outputDir, 'comparison.csv'),
		`${headers.join(',')}\n${rows.map((item) => headers.map((key) => item[key as keyof typeof item]).join(',')).join('\n')}\n`
	);
	const html = reportHtml(rows, matrixId);
	await fs.writeFile(path.join(outputDir, 'index.html'), html);
	await fs.writeFile(path.join(outputDir, 'attendance-capacity-comparison-report.html'), html);
	await fs.writeFile(path.join(outputRoot, 'latest-capacity-matrix.txt'), `${matrixId}\n`);
	console.log(`Capacity comparison: ${path.join(outputDir, 'index.html')}`);
}

await main();
