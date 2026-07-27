import type { PageServerLoad } from './$types';
import { query, queryOne } from '$lib/server/db';
import { error } from '@sveltejs/kit';
import { todayStr, addDaysStr, daysBetween } from '$lib/date';

export const load: PageServerLoad = async ({ params, url }) => {
	const vendor = await queryOne<any>(`SELECT id, name FROM vendors WHERE id = $1`, [params.id]);
	if (!vendor) throw error(404, 'vendor not found');

	const to = url.searchParams.get('to') || todayStr();
	const from = url.searchParams.get('from') || addDaysStr(to, -29);
	const days = daysBetween(from, to);

	const pumps = await query<any>(
		`SELECT pu.id, pu.pump_code, pl.name AS plant_name, a.name AS area_name
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		 WHERE pu.vendor_id = $1 ORDER BY pu.pump_code`,
		[vendor.id]
	);

	const dailyRows = await query<any>(
		`SELECT dpa.pump_id, dpa.session_date,
		        COUNT(*) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched) AS present,
		        COUNT(*) AS total
		 FROM daily_person_attendance dpa
		 JOIN pumps pu ON pu.id = dpa.pump_id
		 WHERE pu.vendor_id = $1 AND dpa.session_date >= $2 AND dpa.session_date <= $3
		 GROUP BY dpa.pump_id, dpa.session_date`,
		[vendor.id, from, to]
	);
	const dailyMap: Record<string, { present: number; total: number }> = {};
	for (const r of dailyRows) {
		const dateKey = r.session_date instanceof Date ? r.session_date.toISOString().slice(0, 10) : r.session_date;
		dailyMap[`${r.pump_id}|${dateKey}`] = { present: Number(r.present), total: Number(r.total) };
	}

	const rangeTotals = await query<any>(
		`SELECT dpa.pump_id,
		        COUNT(*) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched) AS present,
		        COUNT(*) AS total
		 FROM daily_person_attendance dpa
		 JOIN pumps pu ON pu.id = dpa.pump_id
		 WHERE pu.vendor_id = $1 AND dpa.session_date >= $2 AND dpa.session_date <= $3
		 GROUP BY dpa.pump_id`,
		[vendor.id, from, to]
	);
	const totalsMap: Record<string, { present: number; total: number }> = {};
	for (const r of rangeTotals) totalsMap[r.pump_id] = { present: Number(r.present), total: Number(r.total) };

	const pumpsWithPct = pumps.map((p: any) => {
		const t = totalsMap[p.id] || { present: 0, total: 0 };
		return { ...p, attendancePct: t.total > 0 ? Math.round((t.present / t.total) * 1000) / 10 : 0 };
	});

	return { vendor, pumps: pumpsWithPct, range: { from, to }, days, dailyMap };
};
