import type { RequestHandler } from './$types';
import ExcelJS from 'exceljs';
import { query } from '$lib/server/db';
import { personDisplayLabel } from '$lib/personLabel';

export const GET: RequestHandler = async ({ url }) => {
	const areaId = url.searchParams.get('area') || '';
	const vendorId = url.searchParams.get('vendor') || '';
	const plantId = url.searchParams.get('plant') || '';
	const pumpId = url.searchParams.get('pump') || '';
	const session = ['morning', 'evening'].includes(url.searchParams.get('session') || '')
		? url.searchParams.get('session')!
		: '';
	const status = ['present', 'absent'].includes(url.searchParams.get('status') || '')
		? url.searchParams.get('status')!
		: '';
	const day = url.searchParams.get('day') || '';
	let from = url.searchParams.get('from') || '';
	let to = url.searchParams.get('to') || '';

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
		dateCell.value = new Date(r.session_date);
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
