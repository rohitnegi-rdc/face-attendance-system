import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(root, 'test-output', 'load-evaluations');
const requestedCounts = (argument('--agents') || '10,20,30,40')
	.split(',')
	.map(Number)
	.filter((value) => Number.isInteger(value) && value > 0 && value <= 50);

function argument(name: string) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function stamp() {
	return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function runEvaluation(args: string[]) {
	const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
	const runner = path.join(root, 'scripts', 'run-attendance-concurrency-eval.ts');
	const result = spawnSync(process.execPath, [tsxCli, runner, ...args], {
		cwd: root,
		stdio: 'inherit',
		shell: false
	});
	if (result.status !== 0)
		throw new Error(
			`attendance evaluation failed: ${result.error?.message || `exit code ${result.status}`}`
		);
}

async function latestSuccessfulRun(agentCount: number) {
	const entries = await fs.readdir(outputRoot, { withFileTypes: true });
	const candidates = entries
		.filter(
			(entry) => entry.isDirectory() && entry.name.includes(`__attendance-${agentCount}-agents__`)
		)
		.map((entry) => entry.name)
		.sort()
		.reverse();
	for (const runId of candidates) {
		try {
			const summary = JSON.parse(
				await fs.readFile(path.join(outputRoot, runId, 'summary.json'), 'utf8')
			);
			if (summary.combined.completed === agentCount * 2 && summary.combined.failed === 0)
				return { runId, summary };
		} catch {
			// Ignore incomplete diagnostic folders.
		}
	}
	throw new Error(`no successful ${agentCount}-agent run found`);
}

function min(value: number | null) {
	return value == null ? '' : (value / 60_000).toFixed(3);
}

function csvCell(value: unknown) {
	const text = String(value ?? '');
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function comparisonRow(result: any) {
	const { summary, runId } = result;
	return {
		agents_per_wave: summary.virtual_agents,
		total_requests: summary.total_requests,
		completed: summary.combined.completed,
		success_rate_percent: (summary.combined.success_rate * 100).toFixed(1),
		failure_rate_percent: (summary.combined.failure_rate * 100).toFixed(1),
		api_p95_min: min(summary.combined.api_acceptance_ms.p95),
		queue_wait_p50_min: min(summary.combined.queue_wait_ms.p50),
		queue_wait_p95_min: min(summary.combined.queue_wait_ms.p95),
		processing_p95_min: min(summary.combined.processing_ms.p95),
		end_to_end_p50_min: min(summary.combined.end_to_end_ms.p50),
		end_to_end_p95_min: min(summary.combined.end_to_end_ms.p95),
		drain_time_min: min(summary.combined.drain_time_ms),
		peak_queued: summary.combined.peak_queued,
		peak_claimed: summary.combined.peak_claimed,
		throughput_sessions_per_second: summary.combined.throughput_sessions_per_second,
		run_id: runId
	};
}

function matrixHtml(rows: ReturnType<typeof comparisonRow>[], matrixId: string) {
	const latencyHeaders = [
		'Agents / wave',
		'Total requests',
		'Success',
		'Failure',
		'API p95 min',
		'Queue p50 min',
		'Queue p95 min',
		'Processing p95 min',
		'E2E p50 min',
		'E2E p95 min',
		'Drain min'
	];
	const capacityHeaders = ['Agents / wave', 'Peak queue', 'Claimed', 'Throughput / sec', 'Run'];
	const latencyBody = rows
		.map(
			(row) =>
				`<tr><th>${row.agents_per_wave}</th><td>${row.total_requests}</td><td>${row.success_rate_percent}%</td><td>${row.failure_rate_percent}%</td><td>${row.api_p95_min}</td><td>${row.queue_wait_p50_min}</td><td>${row.queue_wait_p95_min}</td><td>${row.processing_p95_min}</td><td>${row.end_to_end_p50_min}</td><td>${row.end_to_end_p95_min}</td><td>${row.drain_time_min}</td></tr>`
		)
		.join('');
	const capacityBody = rows
		.map(
			(row) =>
				`<tr><th>${row.agents_per_wave}</th><td>${row.peak_queued}</td><td>${row.peak_claimed}</td><td>${row.throughput_sessions_per_second}</td><td><a href="../${row.run_id}/index.html">Open ${row.agents_per_wave}-agent report</a></td></tr>`
		)
		.join('');
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Attendance concurrency comparison</title><style>:root{font:16px Arial,sans-serif;color:#162625;background:#f4f7f7}*{box-sizing:border-box}body{margin:0}main{max-width:1400px;margin:auto;padding:24px}h1{margin:0 0 8px}h2{margin:0 0 10px}.panel{background:#fff;border:1px solid #bcc6c5;margin:18px 0;padding:16px;overflow:auto}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #d5dddd;padding:10px;text-align:right;white-space:nowrap}thead th{background:#e8eeee;position:sticky;top:0}tbody th,thead th:first-child{text-align:left}strong{color:#006f62}.notes{line-height:1.55}a{color:#007c6e}@media(max-width:900px){main{padding:14px}th,td{padding:8px;font-size:14px}}</style></head><body><main><h1>Attendance concurrency comparison</h1><p>Run matrix <code>${matrixId}</code>. Each level contains one synchronized morning wave and one synchronized evening wave.</p><section class="panel"><h2>Latency and reliability (minutes)</h2><table><thead><tr>${latencyHeaders.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${latencyBody}</tbody></table></section><section class="panel"><h2>Capacity and detailed reports</h2><table><thead><tr>${capacityHeaders.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${capacityBody}</tbody></table></section><section class="panel notes"><h2>How to reduce latency</h2><p><strong>Queue wait is the scaling bottleneck.</strong> API acceptance remains small, while requests wait behind CPU face inference.</p><ol><li>Increase AI and worker capacity together. More worker claims without more AI inference capacity only moves the waiting line.</li><li>Benchmark <code>AI_SERVICE_WORKERS</code> and <code>WORKER_BATCH_SIZE</code> at matched values such as 2/4, then 4/8, while watching CPU and memory saturation.</li><li>Resize group uploads to the maximum resolution needed for five or six recognizable faces before inference.</li><li>Use a faster detector/embedding runtime, model quantization, or ONNX Runtime CPU optimizations, then compare with the same matrix.</li><li>For production bursts, add horizontal AI replicas and route requests across them. Preserve the database queue for backpressure and retries.</li></ol></section></main></body></html>`;
}

async function regenerateMatrix(matrixId: string) {
	const safeMatrixId = path.basename(matrixId);
	if (safeMatrixId !== matrixId || !/^\d{8}-\d{6}__attendance-concurrency-matrix__/.test(matrixId))
		throw new Error('matrix report requires a valid matrix run ID');
	const outputDir = path.join(outputRoot, safeMatrixId);
	const rows = JSON.parse(
		await fs.readFile(path.join(outputDir, 'comparison.json'), 'utf8')
	) as ReturnType<typeof comparisonRow>[];
	const html = matrixHtml(rows, matrixId);
	await fs.writeFile(path.join(outputDir, 'index.html'), html);
	await fs.writeFile(path.join(outputDir, 'attendance-concurrency-comparison-report.html'), html);
	console.log(
		`Regenerated ${path.join(outputDir, 'attendance-concurrency-comparison-report.html')}`
	);
}

async function main() {
	const matrixRun = argument('--matrix-run');
	if (matrixRun) {
		await regenerateMatrix(matrixRun);
		return;
	}
	if (!requestedCounts.length) throw new Error('provide at least one agent count');
	const results: any[] = [];
	for (const agentCount of requestedCounts) {
		runEvaluation([
			'--scenario',
			'eval/scenarios/attendance-50-concurrent.json',
			'--agents',
			String(agentCount)
		]);
		const result = await latestSuccessfulRun(agentCount);
		results.push(result);
		runEvaluation(['--cleanup-run', result.runId]);
	}
	if (!requestedCounts.includes(50)) results.push(await latestSuccessfulRun(50));
	results.sort((a, b) => a.summary.virtual_agents - b.summary.virtual_agents);
	const rows = results.map(comparisonRow);
	const matrixId = `${stamp()}__attendance-concurrency-matrix__10-20-30-40-50`;
	const outputDir = path.join(outputRoot, matrixId);
	await fs.mkdir(outputDir, { recursive: true });
	await fs.writeFile(path.join(outputDir, 'comparison.json'), `${JSON.stringify(rows, null, 2)}\n`);
	const columns = Object.keys(rows[0]) as (keyof (typeof rows)[0])[];
	await fs.writeFile(
		path.join(outputDir, 'comparison.csv'),
		`${columns.join(',')}\n${rows.map((row) => columns.map((key) => csvCell(row[key])).join(',')).join('\n')}\n`
	);
	const html = matrixHtml(rows, matrixId);
	await fs.writeFile(path.join(outputDir, 'index.html'), html);
	await fs.writeFile(path.join(outputDir, 'attendance-concurrency-comparison-report.html'), html);
	await fs.writeFile(path.join(outputRoot, 'latest-matrix.txt'), `${matrixId}\n`);
	console.log(`Comparison report: ${path.join(outputDir, 'index.html')}`);
}

await main();
