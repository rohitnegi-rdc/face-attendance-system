import type { PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { isDateKey } from '$lib/date';

const SORTABLE_COLUMNS: Record<string, string> = {
	session_date: 'dpa.session_date',
	pump_code: 'pu.pump_code',
	vendor_name: 'v.name',
	area_name: 'a.name',
	status: '(dpa.morning_matched AND dpa.evening_matched)'
};

export const load: PageServerLoad = async ({ url }) => {
	const uuidParam = (name: string) => {
		const value = url.searchParams.get(name) || '';
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
			? value
			: '';
	};
	const dateParam = (name: string) => {
		const value = url.searchParams.get(name) || '';
		return isDateKey(value) ? value : '';
	};
	const areaId = uuidParam('area');
	const vendorId = uuidParam('vendor');
	const plantId = uuidParam('plant');
	const pumpId = uuidParam('pump');
	const session = ['morning', 'evening'].includes(url.searchParams.get('session') || '')
		? url.searchParams.get('session')!
		: '';
	const status = ['present', 'absent'].includes(url.searchParams.get('status') || '')
		? url.searchParams.get('status')!
		: '';
	const attendanceExpression =
		session === 'morning'
			? 'dpa.morning_matched'
			: session === 'evening'
				? 'dpa.evening_matched'
				: '(dpa.morning_matched AND dpa.evening_matched)';
	const day = dateParam('day');
	let from = dateParam('from');
	let to = dateParam('to');
	const requestedPage = Number(url.searchParams.get('page') || '1');
	const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
	const requestedPageSize = Number(url.searchParams.get('page_size') || '50');
	const pageSize = [25, 50, 100].includes(requestedPageSize) ? requestedPageSize : 50;
	const sortCol = SORTABLE_COLUMNS[url.searchParams.get('sort') || ''] || 'dpa.session_date';
	const sortDir = url.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';

	const isSingleDay = Boolean(day);
	if (day) {
		from = day;
		to = day;
	}

	const conditions: string[] = [];
	const params: any[] = [];
	if (areaId) {
		params.push(areaId);
		conditions.push(`a.id = $${params.length}`);
	}
	if (vendorId) {
		params.push(vendorId);
		conditions.push(`v.id = $${params.length}`);
	}
	if (plantId) {
		params.push(plantId);
		conditions.push(`pl.id = $${params.length}`);
	}
	if (pumpId) {
		params.push(pumpId);
		conditions.push(`pu.id = $${params.length}`);
	}
	if (from) {
		params.push(from);
		conditions.push(`dpa.session_date >= $${params.length}`);
	}
	if (to) {
		params.push(to);
		conditions.push(`dpa.session_date <= $${params.length}`);
	}
	if (status) {
		conditions.push(status === 'present' ? attendanceExpression : `NOT ${attendanceExpression}`);
	}
	const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
	const filterParams = [...params];

	const [{ count: totalCount }] = await query<any>(
		`SELECT COUNT(*) AS count
		 FROM daily_person_attendance dpa
		 JOIN pumps pu ON pu.id = dpa.pump_id
		 JOIN vendors v ON v.id = pu.vendor_id
		 JOIN plants pl ON pl.id = pu.plant_id
		 JOIN areas a ON a.id = pl.area_id
		 ${where}`,
		params
	);

	let rows: any[] = [];
	let grouped: any[] = [];

	if (isSingleDay) {
		grouped = await query<any>(
			`SELECT a.id AS area_id, a.name AS area_name, v.id AS vendor_id, v.name AS vendor_name,
			        pu.id AS pump_id, pu.pump_code,
			        COUNT(*) FILTER (WHERE ${attendanceExpression}) AS present,
			        COUNT(*) FILTER (WHERE NOT ${attendanceExpression}) AS absent,
			        COUNT(*) AS total
			 FROM daily_person_attendance dpa
			 JOIN pumps pu ON pu.id = dpa.pump_id
			 JOIN vendors v ON v.id = pu.vendor_id
			 JOIN plants pl ON pl.id = pu.plant_id
			 JOIN areas a ON a.id = pl.area_id
			 ${where}
			 GROUP BY a.id, a.name, v.id, v.name, pu.id, pu.pump_code
			 ORDER BY a.name, v.name, pu.pump_code`,
			params
		);
		rows = await query<any>(
			`SELECT dpa.session_date, dpa.person_id, p.display_seq, pu.id AS pump_id, pu.pump_code,
			        v.id AS vendor_id, v.name AS vendor_name, pl.name AS plant_name, a.id AS area_id, a.name AS area_name,
			        dpa.morning_matched, dpa.evening_matched
			 FROM daily_person_attendance dpa
			 JOIN persons p ON p.id = dpa.person_id
			 JOIN pumps pu ON pu.id = dpa.pump_id
			 JOIN vendors v ON v.id = pu.vendor_id
			 JOIN plants pl ON pl.id = pu.plant_id
			 JOIN areas a ON a.id = pl.area_id
			 ${where}
			 ORDER BY pu.pump_code, p.display_seq`,
			params
		);
	} else {
		params.push(pageSize, (page - 1) * pageSize);
		rows = await query<any>(
			`SELECT dpa.session_date, dpa.person_id, p.display_seq, pu.id AS pump_id, pu.pump_code,
			        v.id AS vendor_id, v.name AS vendor_name, pl.name AS plant_name, a.id AS area_id, a.name AS area_name,
			        dpa.morning_matched, dpa.evening_matched
			 FROM daily_person_attendance dpa
			 JOIN persons p ON p.id = dpa.person_id
			 JOIN pumps pu ON pu.id = dpa.pump_id
			 JOIN vendors v ON v.id = pu.vendor_id
			 JOIN plants pl ON pl.id = pu.plant_id
			 JOIN areas a ON a.id = pl.area_id
			 ${where}
			 ORDER BY ${sortCol} ${sortDir}
			 LIMIT $${params.length - 1} OFFSET $${params.length}`,
			params
		);
	}

	const [summary] = await query<any>(
		`SELECT
		   COUNT(*) FILTER (WHERE ${attendanceExpression}) AS present,
		   COUNT(*) FILTER (WHERE NOT ${attendanceExpression}) AS absent,
		   COUNT(*) AS total
		 FROM daily_person_attendance dpa
		 JOIN pumps pu ON pu.id = dpa.pump_id
		 JOIN vendors v ON v.id = pu.vendor_id
		 JOIN plants pl ON pl.id = pu.plant_id
		 JOIN areas a ON a.id = pl.area_id
		 ${where}`,
		filterParams
	);
	const total = Number(summary?.total ?? 0);
	const present = Number(summary?.present ?? 0);
	const absent = Number(summary?.absent ?? 0);
	const attendancePct = total > 0 ? Math.round((present / total) * 1000) / 10 : 0;

	const areas = await query<any>(`SELECT id, name FROM areas ORDER BY name`);
	const vendors = await query<any>(`SELECT id, name FROM vendors ORDER BY name`);
	const plants = await query<any>(`SELECT id, name FROM plants ORDER BY name`);
	const pumps = await query<any>(`SELECT id, pump_code FROM pumps ORDER BY pump_code`);

	return {
		rows,
		grouped,
		isSingleDay,
		summary: { present, absent, total, attendancePct },
		options: { areas, vendors, plants, pumps },
		filters: {
			area: areaId,
			vendor: vendorId,
			plant: plantId,
			pump: pumpId,
			session,
			status,
			day,
			from,
			to,
			page_size: String(pageSize)
		},
		pagination: {
			page,
			pageSize,
			total: Number(totalCount),
			totalPages: Math.max(1, Math.ceil(Number(totalCount) / pageSize))
		},
		sort: { col: url.searchParams.get('sort') || 'session_date', dir: sortDir.toLowerCase() }
	};
};
