import type { PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { nowIST } from '$lib/server/time';
import { isDateKey } from '$lib/date';

export const load: PageServerLoad = async ({ locals, url }) => {
	const vendorId = locals.user!.id;
	const fallbackTo = nowIST().format('YYYY-MM-DD');
	const fallbackFrom = nowIST().subtract(13, 'day').format('YYYY-MM-DD');
	const requestedFrom = url.searchParams.get('from') || '';
	const requestedTo = url.searchParams.get('to') || '';
	const from = isDateKey(requestedFrom) ? requestedFrom : fallbackFrom;
	const to = isDateKey(requestedTo) ? requestedTo : fallbackTo;
	const uuidParam = (name: string) => {
		const value = url.searchParams.get(name) || '';
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
			? value
			: '';
	};
	const pump = uuidParam('pump');
	const plant = uuidParam('plant');
	const area = uuidParam('area');

	const [pumps, plants, areas, daily, records] = await Promise.all([
		query<any>(`SELECT id, pump_code FROM pumps WHERE vendor_id = $1 ORDER BY pump_code`, [
			vendorId
		]),
		query<any>(
			`SELECT DISTINCT pl.id, pl.name FROM plants pl JOIN pumps pu ON pu.plant_id = pl.id
			 WHERE pu.vendor_id = $1 ORDER BY pl.name`,
			[vendorId]
		),
		query<any>(
			`SELECT DISTINCT a.id, a.name FROM areas a JOIN plants pl ON pl.area_id = a.id
			 JOIN pumps pu ON pu.plant_id = pl.id WHERE pu.vendor_id = $1 ORDER BY a.name`,
			[vendorId]
		),
		query<any>(
			`SELECT pu.id AS pump_id, pu.pump_code, dpa.session_date,
			        COALESCE(ROUND(
			          100.0 * COUNT(*) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched)
			          / NULLIF(COUNT(*), 0)
			        , 0), 0)::int AS attendance_pct
			 FROM daily_person_attendance dpa
			 JOIN pumps pu ON pu.id = dpa.pump_id
			 JOIN plants pl ON pl.id = pu.plant_id
			 WHERE pu.vendor_id = $1 AND dpa.session_date BETWEEN $2 AND $3
			   AND ($4 = '' OR pu.id = $4::uuid)
			   AND ($5 = '' OR pl.id = $5::uuid)
			   AND ($6 = '' OR pl.area_id = $6::uuid)
			 GROUP BY pu.id, dpa.session_date ORDER BY dpa.session_date`,
			[vendorId, from, to, pump, plant, area]
		),
		query<any>(
			`SELECT dpa.session_date, dpa.morning_matched, dpa.evening_matched,
			        p.display_seq, pu.pump_code, pl.name AS plant_name, a.name AS area_name
			 FROM daily_person_attendance dpa
			 JOIN persons p ON p.id = dpa.person_id
			 JOIN pumps pu ON pu.id = dpa.pump_id
			 JOIN plants pl ON pl.id = pu.plant_id
			 JOIN areas a ON a.id = pl.area_id
			 WHERE pu.vendor_id = $1 AND dpa.session_date BETWEEN $2 AND $3
			   AND ($4 = '' OR pu.id = $4::uuid)
			   AND ($5 = '' OR pl.id = $5::uuid)
			   AND ($6 = '' OR a.id = $6::uuid)
			 ORDER BY dpa.session_date DESC, pu.pump_code, p.display_seq LIMIT 500`,
			[vendorId, from, to, pump, plant, area]
		)
	]);

	return { pumps, plants, areas, daily, records, filters: { from, to, pump, plant, area } };
};
