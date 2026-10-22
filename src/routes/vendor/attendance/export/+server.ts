import type { RequestHandler } from './$types';
import { queryOne } from '$lib/server/db';
import { buildAttendanceReport, xlsxResponse } from '$lib/server/attendanceReport';
import { buildHeadcountReport } from '$lib/server/headcountReport';

// The same Excel reports the plant manager gets (attendance by day, monthly headcount), limited
// to this vendor's own pumps. The /vendor prefix is role-guarded in hooks.server.ts.
export const GET: RequestHandler = async ({ locals, url }) => {
	const vendorId = locals.user!.id;
	const vendor = await queryOne<{ name: string }>('SELECT name FROM vendors WHERE id = $1', [
		vendorId
	]);
	const scope = {
		where: 'pu.vendor_id = $1',
		params: [vendorId],
		description: `Vendor, ${vendor?.name ?? 'unknown'}`
	};
	if (url.searchParams.get('report') === 'headcount') {
		const { buffer, filename } = await buildHeadcountReport(scope, url.searchParams.get('month'));
		return xlsxResponse(buffer, filename);
	}
	const { buffer, filename } = await buildAttendanceReport(scope, {
		from: url.searchParams.get('from') || '',
		to: url.searchParams.get('to') || ''
	});
	return xlsxResponse(buffer, filename);
};
