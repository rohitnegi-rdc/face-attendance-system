import type { PageServerLoad } from './$types';
import { query, queryOne } from '$lib/server/db';
import { error } from '@sveltejs/kit';
import { todayStr, addDaysStr, dateKey, daysBetween } from '$lib/date';

const PAGE_SIZES = [25, 50, 100];

function readPaging(url: URL, param: string) {
	const requestedPage = Number(url.searchParams.get(`${param}_page`) || '1');
	const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
	const requestedPageSize = Number(url.searchParams.get(`${param}_page_size`) || '25');
	const pageSize = PAGE_SIZES.includes(requestedPageSize) ? requestedPageSize : 25;
	return { page, pageSize };
}

export const load: PageServerLoad = async ({ params, url }) => {
	const area = await queryOne<any>(`SELECT id, name FROM areas WHERE id = $1`, [params.id]);
	if (!area) throw error(404, 'area not found');

	const to = url.searchParams.get('to') || todayStr();
	const from = url.searchParams.get('from') || addDaysStr(to, -29);
	const days = daysBetween(from, to);

	// --- Plant-level (existing "Attendance by plant") ---
	const plantPaging = readPaging(url, 'plant');
	const [{ count: plantTotal }] = await query<any>(
		`SELECT COUNT(*) AS count FROM plants WHERE area_id = $1`,
		[area.id]
	);
	const plants = await query<any>(
		`SELECT id, name, manager_name, manager_email
		 FROM plants WHERE area_id = $1 ORDER BY name LIMIT $2 OFFSET $3`,
		[area.id, plantPaging.pageSize, (plantPaging.page - 1) * plantPaging.pageSize]
	);
	const plantIds = plants.map((p: any) => p.id);

	const plantDailyRows = plantIds.length
		? await query<any>(
				`SELECT pu.plant_id, dpa.session_date,
			        COUNT(*) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched) AS present,
			        COUNT(*) AS total
			 FROM daily_person_attendance dpa
			 JOIN pumps pu ON pu.id = dpa.pump_id
			 WHERE pu.plant_id = ANY($1) AND dpa.session_date >= $2 AND dpa.session_date <= $3
			 GROUP BY pu.plant_id, dpa.session_date`,
				[plantIds, from, to]
			)
		: [];
	const plantDailyMap: Record<string, { present: number; total: number }> = {};
	for (const r of plantDailyRows) {
		plantDailyMap[`${r.plant_id}|${dateKey(r.session_date)}`] = {
			present: Number(r.present),
			total: Number(r.total)
		};
	}
	const plantRangeTotals = plantIds.length
		? await query<any>(
				`SELECT pu.plant_id,
			        COUNT(*) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched) AS present,
			        COUNT(*) AS total
			 FROM daily_person_attendance dpa
			 JOIN pumps pu ON pu.id = dpa.pump_id
			 WHERE pu.plant_id = ANY($1) AND dpa.session_date >= $2 AND dpa.session_date <= $3
			 GROUP BY pu.plant_id`,
				[plantIds, from, to]
			)
		: [];
	const plantTotalsMap: Record<string, { present: number; total: number }> = {};
	for (const r of plantRangeTotals)
		plantTotalsMap[r.plant_id] = { present: Number(r.present), total: Number(r.total) };
	const plantsWithPct = plants.map((p: any) => {
		const t = plantTotalsMap[p.id] || { present: 0, total: 0 };
		return { ...p, attendancePct: t.total > 0 ? Math.round((t.present / t.total) * 1000) / 10 : 0 };
	});

	// --- Pump-level (new "Attendance by pump") — pl.area_id join, one hop past plants ---
	const pumpPaging = readPaging(url, 'pump');
	const [{ count: pumpTotal }] = await query<any>(
		`SELECT COUNT(*) AS count FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id WHERE pl.area_id = $1`,
		[area.id]
	);
	const pumps = await query<any>(
		`SELECT pu.id, pu.pump_code, pl.name AS plant_name
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id
		 WHERE pl.area_id = $1 ORDER BY pu.pump_code
		 LIMIT $2 OFFSET $3`,
		[area.id, pumpPaging.pageSize, (pumpPaging.page - 1) * pumpPaging.pageSize]
	);
	const pumpIds = pumps.map((p: any) => p.id);

	const pumpDailyRows = pumpIds.length
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
	const pumpDailyMap: Record<string, { present: number; total: number }> = {};
	for (const r of pumpDailyRows) {
		pumpDailyMap[`${r.pump_id}|${dateKey(r.session_date)}`] = {
			present: Number(r.present),
			total: Number(r.total)
		};
	}
	const pumpRangeTotals = pumpIds.length
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
	const pumpTotalsMap: Record<string, { present: number; total: number }> = {};
	for (const r of pumpRangeTotals)
		pumpTotalsMap[r.pump_id] = { present: Number(r.present), total: Number(r.total) };
	const pumpsWithPct = pumps.map((p: any) => {
		const t = pumpTotalsMap[p.id] || { present: 0, total: 0 };
		return { ...p, attendancePct: t.total > 0 ? Math.round((t.present / t.total) * 1000) / 10 : 0 };
	});

	return {
		area,
		plants: plantsWithPct,
		plantPagination: {
			page: plantPaging.page,
			pageSize: plantPaging.pageSize,
			total: Number(plantTotal),
			totalPages: Math.max(1, Math.ceil(Number(plantTotal) / plantPaging.pageSize))
		},
		plantDailyMap,
		pumps: pumpsWithPct,
		pumpPagination: {
			page: pumpPaging.page,
			pageSize: pumpPaging.pageSize,
			total: Number(pumpTotal),
			totalPages: Math.max(1, Math.ceil(Number(pumpTotal) / pumpPaging.pageSize))
		},
		pumpDailyMap,
		range: { from, to },
		days
	};
};
