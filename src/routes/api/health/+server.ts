import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pool } from '$lib/server/db';

export const GET: RequestHandler = async () => {
	const aiServiceUrl = process.env.AI_SERVICE_URL?.trim();
	const workerHeartbeatTimeout = Number(process.env.WORKER_HEARTBEAT_TIMEOUT_SECONDS ?? 20);
	const queueLagLimit = Number(process.env.ATTENDANCE_QUEUE_LAG_LIMIT_SECONDS ?? 300);
	const [databaseStatus, aiServiceReady] = await Promise.all([
		pool
			.query(
				`SELECT
				  EXISTS (SELECT 1 FROM worker_heartbeats
				          WHERE last_seen_at > now() - make_interval(secs => $1::double precision)) AS worker_alive,
				  count(*) FILTER (WHERE status = 'queued')::int AS queue_depth,
				  COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'queued'))), 0)::int AS oldest_queued_seconds,
				  count(*) FILTER (WHERE status = 'claimed' AND claimed_at < now() - interval '10 minutes')::int AS stale_claimed_jobs
				 FROM attendance_jobs`,
				[workerHeartbeatTimeout]
			)
			.then((result) => result.rows[0])
			.catch(() => null),
		aiServiceUrl
			? fetch(new URL('/health', aiServiceUrl), { signal: AbortSignal.timeout(2500) })
					.then(async (response) => {
						if (!response.ok) return false;
						const health = (await response.json()) as {
							status?: string;
						model_loaded?: boolean;
						anti_spoof_enabled?: boolean;
						anti_spoof_ready?: boolean;
					};
						return (
							health.status === 'ok' &&
							health.model_loaded === true &&
							(health.anti_spoof_enabled !== true || health.anti_spoof_ready === true)
						);
					})
					.catch(() => false)
			: Promise.resolve(false)
	]);
	const databaseReady = databaseStatus !== null;
	const workerReady = databaseStatus?.worker_alive === true;
	const queueReady =
		databaseStatus !== null &&
		databaseStatus.oldest_queued_seconds <= queueLagLimit &&
		databaseStatus.stale_claimed_jobs === 0;
	const ready = databaseReady && aiServiceReady && workerReady && queueReady;

	return json(
		{
			status: ready ? 'ok' : 'unavailable',
			database: databaseReady ? 'ok' : 'unavailable',
			ai_service: aiServiceReady ? 'ok' : 'unavailable',
			worker: workerReady ? 'ok' : 'unavailable',
			queue: databaseStatus
				? {
					status: queueReady ? 'ok' : 'degraded',
					depth: databaseStatus.queue_depth,
					oldest_queued_seconds: databaseStatus.oldest_queued_seconds,
					stale_claimed_jobs: databaseStatus.stale_claimed_jobs,
					lag_limit_seconds: queueLagLimit
				}
				: { status: 'unavailable' }
		},
		{ status: ready ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
};
