// Today's attendance per area, plant and pump for the admin Overview, Areas and Plants pages.
// Every level counts the same way as the Overview totals (daily_person_attendance: present = start
// and end both matched), so the rows of one level add up to the level above. Dates are IST
// "YYYY-MM-DD" strings from todayIST().
import { query } from '$lib/server/db';
import { addDaysStr, dateKey, daysBetween } from '$lib/date';

export type GroupToday = {
	id: string;
	name: string;
	areaId: string | null;
	areaName: string | null;
	plants: number;
	pumps: number;
	reporting: number;
	present: number;
	total: number;
	pct: number;
	fraud: number;
};

export type PumpToday = {
	id: string;
	pumpCode: string;
	vendorName: string;
	plantId: string;
	plantName: string;
	startAt: string | null;
	endAt: string | null;
	present: number;
	total: number;
	rangePresent: number;
	rangeTotal: number;
	rangePct: number | null;
	fraud: number;
};

const pct = (present: number, total: number) =>
	total > 0 ? Math.round((present / total) * 100) : 0;

// One row per area or plant that has pumps, by name (plants by area, then name). `filter` limits
// the rows to one area, one plant, or a name/area search.
export async function groupsToday(
	level: 'area' | 'plant',
	today: string,
	filter: { areaId?: string; plantId?: string; q?: string } = {}
): Promise<GroupToday[]> {
	const isArea = level === 'area';
	// The pumps of the group `g`: for an area through its plants, for a plant directly.
	const pumpsOf = isArea
		? 'pu.plant_id IN (SELECT id FROM plants WHERE area_id = g.id)'
		: 'pu.plant_id = g.id';
	const q = (filter.q ?? '').trim().slice(0, 100);
	const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const rows = await query<any>(
		`SELECT g.id, g.name, ${isArea ? 'NULL::uuid AS area_id, NULL AS area_name' : 'a.id AS area_id, a.name AS area_name'},
		        ${isArea ? '(SELECT count(*) FROM plants WHERE area_id = g.id)' : '0'} AS plants,
		        (SELECT count(*) FROM pumps pu WHERE ${pumpsOf}) AS pumps,
		        (SELECT count(DISTINCT s.pump_id) FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
		          WHERE ${pumpsOf} AND s.session_date = $1) AS reporting,
		        (SELECT count(*) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched)
		          FROM daily_person_attendance dpa JOIN pumps pu ON pu.id = dpa.pump_id
		          WHERE ${pumpsOf} AND dpa.session_date = $1) AS present,
		        (SELECT count(*) FROM daily_person_attendance dpa JOIN pumps pu ON pu.id = dpa.pump_id
		          WHERE ${pumpsOf} AND dpa.session_date = $1) AS total,
		        (SELECT count(*) FROM fraud_flags ff JOIN attendance_sessions s ON s.id = ff.session_id
		          JOIN pumps pu ON pu.id = s.pump_id
		          WHERE ${pumpsOf} AND (ff.created_at AT TIME ZONE 'Asia/Kolkata')::date = $1) AS fraud
		 FROM ${isArea ? 'areas g' : 'plants g JOIN areas a ON a.id = g.area_id'}
		 WHERE ($2::uuid IS NULL OR ${isArea ? 'g.id' : 'g.area_id'} = $2::uuid)
		   AND ($3 = '' OR g.name ILIKE $4${
					isArea
						? ' OR EXISTS (SELECT 1 FROM plants p2 WHERE p2.area_id = g.id AND p2.name ILIKE $4)'
						: ' OR a.name ILIKE $4'
				})
		   AND ($5::uuid IS NULL OR g.id = $5::uuid)
		 ORDER BY ${isArea ? 'g.name' : 'a.name, g.name'}`,
		[today, filter.areaId ?? null, q, like, filter.plantId ?? null]
	);
	return rows
		.filter((row) => Number(row.pumps) > 0)
		.map((row) => {
			const present = Number(row.present);
			const total = Number(row.total);
			return {
				id: row.id,
				name: row.name,
				areaId: row.area_id,
				areaName: row.area_name,
				plants: Number(row.plants),
				pumps: Number(row.pumps),
				reporting: Number(row.reporting),
				present,
				total,
				pct: pct(present, total),
				fraud: Number(row.fraud)
			};
		});
}

// Every pump of a plant or an area: today's start and end photo times, present today, and
// attendance over from..to. Ordered by plant, then pump code.
export async function pumpsToday(
	scope: { plantId: string } | { areaId: string },
	today: string,
	from: string,
	to: string
): Promise<PumpToday[]> {
	const where = 'plantId' in scope ? 'pu.plant_id = $1' : 'pl.area_id = $1';
	const id = 'plantId' in scope ? scope.plantId : scope.areaId;
	const rows = await query<any>(
		`SELECT pu.id, pu.pump_code, v.name AS vendor_name, pl.id AS plant_id, pl.name AS plant_name,
		        (SELECT min(s.submitted_at) FROM attendance_sessions s WHERE s.pump_id = pu.id
		          AND s.session_date = $2 AND s.session_type = 'morning' AND s.status <> 'failed') AS start_at,
		        (SELECT max(s.submitted_at) FROM attendance_sessions s WHERE s.pump_id = pu.id
		          AND s.session_date = $2 AND s.session_type = 'evening' AND s.status <> 'failed') AS end_at,
		        (SELECT count(*) FILTER (WHERE morning_matched AND evening_matched) FROM daily_person_attendance
		          WHERE pump_id = pu.id AND session_date = $2) AS present,
		        (SELECT count(*) FROM daily_person_attendance
		          WHERE pump_id = pu.id AND session_date = $2) AS total,
		        (SELECT count(*) FILTER (WHERE morning_matched AND evening_matched) FROM daily_person_attendance
		          WHERE pump_id = pu.id AND session_date BETWEEN $3 AND $4) AS range_present,
		        (SELECT count(*) FROM daily_person_attendance
		          WHERE pump_id = pu.id AND session_date BETWEEN $3 AND $4) AS range_total,
		        (SELECT count(*) FROM fraud_flags ff JOIN attendance_sessions s ON s.id = ff.session_id
		          WHERE s.pump_id = pu.id AND (ff.created_at AT TIME ZONE 'Asia/Kolkata')::date = $2) AS fraud
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN vendors v ON v.id = pu.vendor_id
		 WHERE ${where}
		 ORDER BY pl.name, pu.pump_code`,
		[id, today, from, to]
	);
	return rows.map((row) => {
		const rangePresent = Number(row.range_present);
		const rangeTotal = Number(row.range_total);
		return {
			id: row.id,
			pumpCode: row.pump_code,
			vendorName: row.vendor_name,
			plantId: row.plant_id,
			plantName: row.plant_name,
			startAt: row.start_at ? new Date(row.start_at).toISOString() : null,
			endAt: row.end_at ? new Date(row.end_at).toISOString() : null,
			present: Number(row.present),
			total: Number(row.total),
			rangePresent,
			rangeTotal,
			rangePct: rangeTotal > 0 ? pct(rangePresent, rangeTotal) : null,
			fraud: Number(row.fraud)
		};
	});
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The ?from=&to= range of an area or plant page, the last 30 days by default. `label` names it
// for the pump list column.
export function readRange(url: URL, today: string) {
	const toParam = url.searchParams.get('to') ?? '';
	const fromParam = url.searchParams.get('from') ?? '';
	const to = DAY.test(toParam) ? toParam : today;
	const defaultFrom = addDaysStr(to, -29);
	const from = DAY.test(fromParam) && fromParam <= to ? fromParam : defaultFrom;
	const isDefault = to === today && from === defaultFrom;
	return {
		from,
		to,
		days: daysBetween(from, to),
		label: isDefault ? 'Last 30 days' : 'Selected days'
	};
}

// Percent present per entity per day for the calendar grid, keyed "id|YYYY-MM-DD". `by` picks the
// entity: each pump, or each plant (its pumps added together).
export async function dailyPercent(
	by: 'pump' | 'plant',
	ids: string[],
	from: string,
	to: string
): Promise<Record<string, number>> {
	if (!ids.length) return {};
	const key = by === 'pump' ? 'pu.id' : 'pu.plant_id';
	const rows = await query<any>(
		`SELECT ${key} AS id, dpa.session_date,
		        count(*) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched) AS present,
		        count(*) AS total
		 FROM daily_person_attendance dpa JOIN pumps pu ON pu.id = dpa.pump_id
		 WHERE ${key} = ANY($1) AND dpa.session_date BETWEEN $2 AND $3
		 GROUP BY ${key}, dpa.session_date`,
		[ids, from, to]
	);
	const out: Record<string, number> = {};
	for (const row of rows) {
		const total = Number(row.total);
		if (total > 0) out[`${row.id}|${dateKey(row.session_date)}`] = pct(Number(row.present), total);
	}
	return out;
}
