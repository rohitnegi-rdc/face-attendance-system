import type { RequestHandler } from './$types';
import ExcelJS from 'exceljs';
import { query } from '$lib/server/db';
import { personDisplayLabel } from '$lib/personLabel';
import { dateKey, isDateKey } from '$lib/date';

export const GET: RequestHandler = async ({ url }) => {
	const uuidParam = (name: string) => {
		const value = url.searchParams.get(name) || '';
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
			? value
			: '';
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
	const requestedDay = url.searchParams.get('day') || '';
	const requestedFrom = url.searchParams.get('from') || '';
	const requestedTo = url.searchParams.get('to') || '';
	const day = isDateKey(requestedDay) ? requestedDay : '';
	let from = isDateKey(requestedFrom) ? requestedFrom : '';
	let to = isDateKey(requestedTo) ? requestedTo : '';

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
		const expression =
			session === 'morning'
				? 'dpa.morning_matched'
				: session === 'evening'
					? 'dpa.evening_matched'
					: '(dpa.morning_matched AND dpa.evening_matched)';
		conditions.push(status === 'present' ? expression : `NOT ${expression}`);
	}
	const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

	const rows = await query<any>(
		`SELECT dpa.session_date, dpa.person_id, p.display_seq, pu.pump_code, v.name AS vendor_name, pl.name AS plant_name,
		        a.name AS area_name, dpa.morning_matched, dpa.evening_matched
		 FROM daily_person_attendance dpa
		 JOIN persons p ON p.id = dpa.person_id
		 JOIN pumps pu ON pu.id = dpa.pump_id
		 JOIN vendors v ON v.id = pu.vendor_id
		 JOIN plants pl ON pl.id = pu.plant_id
		 JOIN areas a ON a.id = pl.area_id
		 ${where}
		 ORDER BY dpa.session_date DESC`,
		params
	);

	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet('Attendance');
	sheet.columns = [
		{ header: 'Date', key: 'session_date' },
		{ header: 'Person', key: 'person_label' },
		{ header: 'Pump', key: 'pump_code' },
		{ header: 'Vendor', key: 'vendor_name' },
		{ header: 'Plant', key: 'plant_name' },
		{ header: 'Area', key: 'area_name' },
		{ header: 'Morning', key: 'morning_status' },
		{ header: 'Evening', key: 'evening_status' },
		{
			header: session ? `${session[0].toUpperCase()}${session.slice(1)} Status` : 'Daily Status',
			key: 'status'
		}
	];
	for (const r of rows) {
		const row = sheet.addRow({
			...r,
			person_label: personDisplayLabel(r.pump_code, r.display_seq),
			morning_status: r.morning_matched ? 'Present' : 'Absent',
			evening_status: r.evening_matched ? 'Present' : 'Absent',
			status:
				session === 'morning'
					? r.morning_matched
						? 'Present'
						: 'Absent'
					: session === 'evening'
						? r.evening_matched
							? 'Present'
							: 'Absent'
						: r.morning_matched && r.evening_matched
							? 'Present'
							: 'Absent'
		});
		const dateCell = row.getCell('session_date');
		dateCell.value = new Date(`${dateKey(r.session_date)}T00:00:00Z`);
		dateCell.numFmt = 'ddd, dd mmm yyyy';
	}

	const buffer = await workbook.xlsx.writeBuffer();
	return new Response(buffer, {
		headers: {
			'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'content-disposition': 'attachment; filename="attendance.xlsx"'
		}
	});
};
