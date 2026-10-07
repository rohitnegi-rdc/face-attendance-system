// Queue-depth autoscaler for the `worker` service: scales `docker compose --scale worker=N`
// up fast when attendance_jobs backlog grows, and back down after a sustained cooldown once
// the queue drains, so bursts don't leave idle worker containers running indefinitely.
// Run with: npx tsx scripts/autoscale-workers.ts
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const { Pool } = pg;

const POLL_INTERVAL_MS = Number(process.env.AUTOSCALE_POLL_INTERVAL_MS ?? 30000);
const MIN_WORKERS = Number(process.env.AUTOSCALE_MIN_WORKERS ?? 1);
const MAX_WORKERS = Number(process.env.AUTOSCALE_MAX_WORKERS ?? 5);
const JOBS_PER_WORKER = Number(process.env.AUTOSCALE_JOBS_PER_WORKER ?? 10);
const SCALE_DOWN_COOLDOWN_MS = Number(process.env.AUTOSCALE_SCALE_DOWN_COOLDOWN_MS ?? 5 * 60 * 1000);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function log(fields: Record<string, unknown>, message: string) {
	console.log(JSON.stringify({ service: 'autoscale-workers', timestamp: new Date().toISOString(), ...fields, message }));
}

function clamp(n: number, min: number, max: number) {
	return Math.max(min, Math.min(max, n));
}

async function queueDepth(): Promise<number> {
	const { rows } = await pool.query(
		`SELECT count(*)::int AS depth FROM attendance_jobs WHERE status IN ('queued', 'claimed')`
	);
	return rows[0].depth;
}

function applyScale(target: number) {
	const result = spawnSync('docker', ['compose', 'up', '-d', '--scale', `worker=${target}`], {
		stdio: 'inherit'
	});
	if (result.status !== 0) {
		throw new Error(`docker compose scale failed with exit code ${result.status}`);
	}
}

async function main() {
	let currentWorkers = MIN_WORKERS;
	let belowTargetSince: number | null = null;

	log({ minWorkers: MIN_WORKERS, maxWorkers: MAX_WORKERS, jobsPerWorker: JOBS_PER_WORKER }, 'autoscaler started');

	while (true) {
		try {
			const depth = await queueDepth();
			const desired = depth === 0 ? MIN_WORKERS : clamp(Math.ceil(depth / JOBS_PER_WORKER), MIN_WORKERS, MAX_WORKERS);

			if (desired > currentWorkers) {
				log({ depth, from: currentWorkers, to: desired }, 'scaling up');
				applyScale(desired);
				currentWorkers = desired;
				belowTargetSince = null;
			} else if (desired < currentWorkers) {
				if (belowTargetSince === null) belowTargetSince = Date.now();
				const idleFor = Date.now() - belowTargetSince;
				if (idleFor >= SCALE_DOWN_COOLDOWN_MS) {
					log({ depth, from: currentWorkers, to: desired, idleForMs: idleFor }, 'scaling down after cooldown');
					applyScale(desired);
					currentWorkers = desired;
					belowTargetSince = null;
				} else {
					log({ depth, currentWorkers, desired, idleForMs: idleFor }, 'below target, waiting out cooldown');
				}
			} else {
				belowTargetSince = null;
				log({ depth, currentWorkers }, 'steady state');
			}
		} catch (err) {
			log({ error: String((err as Error)?.message ?? err) }, 'autoscale poll failed');
		}
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
}

main();
