import type { RequestHandler } from './$types';
import { query } from '$lib/server/db';
import { buildAttendanceReport, xlsxResponse } from '$lib/server/attendanceReport';
import { buildHeadcountReport } from '$lib/server/headcountReport';

// The /plant-manager prefix is role-guarded in hooks.server.ts; the scope below limits the
// report to the plants assigned to this manager.
export const GET: RequestHandler = async ({ locals, url }) => {
	const managerId = locals.user!.id;
	const plants = await query<{ name: string }>(
		`SELECT pl.name FROM plants pl JOIN plant_manager_assignments pma ON pma.plant_id = pl.id
		 WHERE pma.manager_id = $1 ORDER BY pl.name`,
		[managerId]
	);
	const scope = {
		where: `pl.id IN (SELECT plant_id FROM plant_manager_assignments WHERE manager_id = $1)`,
		params: [managerId],
		description: `Plant manager, ${plants.map((p) => p.name).join(', ') || 'no plants assigned'}`
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
