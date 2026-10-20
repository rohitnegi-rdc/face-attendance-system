import type { RequestHandler } from './$types';
import { queryOne } from '$lib/server/db';
import { buildAttendanceReport, xlsxResponse } from '$lib/server/attendanceReport';
import { buildHeadcountReport } from '$lib/server/headcountReport';
import { isDateKey } from '$lib/date';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Same filters as /admin/attendance, so the export matches what the admin is looking at.
export const GET: RequestHandler = async ({ url }) => {
	const uuidParam = (name: string) => {
		const value = url.searchParams.get(name) || '';
		return UUID.test(value) ? value : '';
	};
	const filters = [
		['area', 'a.id', 'SELECT name FROM areas WHERE id = $1'],
		['vendor', 'v.id', 'SELECT name FROM vendors WHERE id = $1'],
		['plant', 'pl.id', 'SELECT name FROM plants WHERE id = $1'],
		['pump', 'pu.id', 'SELECT pump_code AS name FROM pumps WHERE id = $1']
	] as const;

	const conditions: string[] = [];
	const params: unknown[] = [];
	const labels: string[] = [];
	for (const [param, column, nameSql] of filters) {
		const id = uuidParam(param);
		if (!id) continue;
		params.push(id);
		conditions.push(`${column} = $${params.length}`);
		const row = await queryOne<{ name: string }>(nameSql, [id]);
		labels.push(`${param} ${row?.name ?? id}`);
	}

	const scope = {
		where: conditions.length ? conditions.join(' AND ') : 'true',
		params,
		description: labels.length ? `Admin, ${labels.join(', ')}` : 'Admin, all areas'
	};
	if (url.searchParams.get('report') === 'headcount') {
		const { buffer, filename } = await buildHeadcountReport(scope, url.searchParams.get('month'));
		return xlsxResponse(buffer, filename);
	}

	const session = url.searchParams.get('session');
	const status = url.searchParams.get('status');
	const day = url.searchParams.get('day') || '';
	const { buffer, filename } = await buildAttendanceReport(scope, {
		from: isDateKey(day) ? day : url.searchParams.get('from') || '',
		to: isDateKey(day) ? day : url.searchParams.get('to') || '',
		session: session === 'morning' || session === 'evening' ? session : '',
		status: status === 'present' || status === 'absent' ? status : ''
	});
	return xlsxResponse(buffer, filename);
};
