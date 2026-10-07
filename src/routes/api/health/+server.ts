import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pool } from '$lib/server/db';

export const GET: RequestHandler = async () => {
	const aiServiceUrl = process.env.AI_SERVICE_URL?.trim();
	const [databaseReady, aiServiceReady] = await Promise.all([
		pool.query('SELECT 1').then(
			() => true,
			() => false
		),
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
	const ready = databaseReady && aiServiceReady;

	return json(
		{
			status: ready ? 'ok' : 'unavailable',
			database: databaseReady ? 'ok' : 'unavailable',
			ai_service: aiServiceReady ? 'ok' : 'unavailable'
		},
		{ status: ready ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
};
