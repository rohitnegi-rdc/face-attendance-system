import type { PageServerLoad } from './$types';
import { query, queryOne } from '$lib/server/db';
import { error } from '@sveltejs/kit';
import { todayStr, addDaysStr, dateKey, daysBetween } from '$lib/date';

const PAGE_SIZES = [25, 50, 100];

export const load: PageServerLoad = async ({ params, url }) => {
	const vendor = await queryOne<any>(
		`SELECT v.id, v.name, v.email, a.name AS area_name
		 FROM vendors v LEFT JOIN areas a ON a.id = v.area_id
		 WHERE v.id = $1`,
		[params.id]
	);
	if (!vendor) throw error(404, 'vendor not found');

	const to = url.searchParams.get('to') || todayStr();
	const from = url.searchParams.get('from') || addDaysStr(to, -29);
	const days = daysBetween(from, to);

	const requestedPage = Number(url.searchParams.get('page') || '1');
	const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
	const requestedPageSize = Number(url.searchParams.get('page_size') || '25');
	const pageSize = PAGE_SIZES.includes(requestedPageSize) ? requestedPageSize : 25;

	const [{ count: totalCount }] = await query<any>(
		`SELECT COUNT(*) AS count FROM pumps WHERE vendor_id = $1`,
		[vendor.id]
	);

	const pumps = await query<any>(
		`SELECT pu.id, pu.pump_code, pl.name AS plant_name, a.name AS area_name
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		 WHERE pu.vendor_id = $1 ORDER BY pu.pump_code
		 LIMIT $2 OFFSET $3`,
		[vendor.id, pageSize, (page - 1) * pageSize]
	);
	const pumpIds = pumps.map((p: any) => p.id);

	const dailyRows = pumpIds.length
		? await query<any>(
				`SELECT dpa.pump_id, dpa.session_date,
			        COUNT(*) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched) AS present,
			        COUNT(*) AS total
			 FROM daily_person_attendance dpa
			 WHERE dpa.pump_id = ANY($1) AND dpa.session_date >= $2 AND dpa.session_date <= $3
			 GROUP BY dpa.pump_id, dpa.session_date`,
				[pumpIds, from, to]
			)
		: [];
	const dailyMap: Record<string, { present: number; total: number }> = {};
	for (const r of dailyRows) {
		dailyMap[`${r.pump_id}|${dateKey(r.session_date)}`] = {
			present: Number(r.present),
			total: Number(r.total)
		};
	}

	const rangeTotals = pumpIds.length
		? await query<any>(
				`SELECT dpa.pump_id,
			        COUNT(*) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched) AS present,
			        COUNT(*) AS total
			 FROM daily_person_attendance dpa
			 WHERE dpa.pump_id = ANY($1) AND dpa.session_date >= $2 AND dpa.session_date <= $3
			 GROUP BY dpa.pump_id`,
				[pumpIds, from, to]
			)
		: [];
	const totalsMap: Record<string, { present: number; total: number }> = {};
	for (const r of rangeTotals)
		totalsMap[r.pump_id] = { present: Number(r.present), total: Number(r.total) };

	const pumpsWithPct = pumps.map((p: any) => {
		const t = totalsMap[p.id] || { present: 0, total: 0 };
		return { ...p, attendancePct: t.total > 0 ? Math.round((t.present / t.total) * 1000) / 10 : 0 };
	});

	return {
		vendor,
		pumps: pumpsWithPct,
		pagination: {
			page,
			pageSize,
			total: Number(totalCount),
			totalPages: Math.max(1, Math.ceil(Number(totalCount) / pageSize))
		},
		range: { from, to },
		days,
		dailyMap
	};
};
