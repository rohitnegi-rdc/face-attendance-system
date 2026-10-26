import type { PageServerLoad } from './$types';
import { query } from '$lib/server/db';

// Every pump, searchable by pump code, plant, area, vendor or login, 50 a page. Each row opens
// the pump page (attendance calendar, session log, admin fixes, Clear test records).
const PAGE_SIZE = 50;

export const load: PageServerLoad = async ({ url }) => {
	const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
	const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const requestedPage = Number(url.searchParams.get('page') || '1');
	const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
	const where = `($1 = '' OR pu.pump_code ILIKE $2 OR pu.login_email ILIKE $2 OR pl.name ILIKE $2
	               OR a.name ILIKE $2 OR v.name ILIKE $2)`;

	const [pumps, total] = await Promise.all([
		query<{
			id: string;
			pump_code: string;
			login_email: string;
			status: string;
			plant_name: string;
			area_name: string;
			vendor_name: string;
			people: number;
			last_photo_at: Date | null;
		}>(
			`SELECT pu.id, pu.pump_code, pu.login_email, pu.status, pl.name AS plant_name,
			        a.name AS area_name, v.name AS vendor_name,
			        (SELECT count(*)::int FROM persons p WHERE p.pump_id = pu.id AND p.status = 'active') AS people,
			        (SELECT max(s.submitted_at) FROM attendance_sessions s WHERE s.pump_id = pu.id) AS last_photo_at
			 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
			 JOIN vendors v ON v.id = pu.vendor_id
			 WHERE ${where}
			 ORDER BY pu.pump_code
			 LIMIT $3 OFFSET $4`,
			[q, like, PAGE_SIZE, (page - 1) * PAGE_SIZE]
		),
		query<{ n: number }>(
			`SELECT count(*)::int AS n
			 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
			 JOIN vendors v ON v.id = pu.vendor_id
			 WHERE ${where}`,
			[q, like]
		)
	]);
	const count = total[0]?.n ?? 0;
	return {
		pumps,
		q,
		pagination: { page, total: count, totalPages: Math.max(1, Math.ceil(count / PAGE_SIZE)) }
	};
};
