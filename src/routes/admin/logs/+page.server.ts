import type { PageServerLoad } from './$types';
import { query, queryOne } from '$lib/server/db';

const LEVELS = ['warn', 'error'] as const;
const SERVICES = ['app', 'worker'] as const;
const DAYS = [1, 7, 30] as const;
const LIMIT = 300;

export type LogLine = {
	id: string;
	logged_at: string;
	level: 'warn' | 'error' | 'fatal';
	service: string;
	message: string;
	request_id: string | null;
	session_id: string | null;
	pump_code: string | null;
	details: Record<string, unknown>;
};

// Warnings and errors from every service (system_logs, written by src/lib/server/log.ts and the
// worker). Search matches the message, the details, a pump code, or an exact request/session id.
export const load: PageServerLoad = async ({ url }) => {
	const levelParam = url.searchParams.get('level') ?? '';
	const level = (LEVELS as readonly string[]).includes(levelParam) ? levelParam : '';
	const serviceParam = url.searchParams.get('service') ?? '';
	const service = (SERVICES as readonly string[]).includes(serviceParam) ? serviceParam : '';
	const daysParam = Number(url.searchParams.get('days'));
	const days = (DAYS as readonly number[]).includes(daysParam) ? daysParam : 7;
	const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
	const like = `%${q.replace(/[\%_]/g, (c) => `\${c}`)}%`;

	const lines = await query<LogLine>(
		`SELECT l.id::text, l.level, l.service, l.message, l.request_id, l.session_id, l.details,
		        to_char(l.logged_at AT TIME ZONE 'Asia/Kolkata', 'DD-MM-YYYY, HH24:MI:SS') AS logged_at,
		        coalesce(pu.pump_code, spu.pump_code) AS pump_code
		 FROM system_logs l
		 LEFT JOIN pumps pu ON pu.id::text = l.pump_id
		 LEFT JOIN attendance_sessions s ON s.id::text = l.session_id
		 LEFT JOIN pumps spu ON spu.id = s.pump_id
		 WHERE l.logged_at >= now() - make_interval(days => $1)
		   AND ($2 = '' OR l.level = $2 OR ($2 = 'error' AND l.level = 'fatal'))
		   AND ($3 = '' OR l.service = $3)
		   AND ($4 = '' OR l.request_id = $4 OR l.session_id = $4
		        OR l.message ILIKE $5 OR l.details::text ILIKE $5
		        OR coalesce(pu.pump_code, spu.pump_code) ILIKE $5)
		 ORDER BY l.logged_at DESC, l.id DESC
		 LIMIT ${LIMIT}`,
		[days, level, service, q, like]
	);

	const counts = await queryOne<{ errors: number; warnings: number }>(
		`SELECT count(*) FILTER (WHERE level IN ('error', 'fatal'))::int AS errors,
		        count(*) FILTER (WHERE level = 'warn')::int AS warnings
		 FROM system_logs WHERE logged_at >= now() - interval '24 hours'`
	);

	return {
		lines,
		limit: LIMIT,
		counts: counts ?? { errors: 0, warnings: 0 },
		filters: { level, service, days, q }
	};
};
