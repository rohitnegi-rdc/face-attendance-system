import type { LayoutServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { queryOne } from '$lib/server/db';
import { loadNavCounts, sectionForPath } from '$lib/server/navCounts';

export const load: LayoutServerLoad = async ({ locals, url, depends }) => {
	depends('app:nav-counts');
	const manager = await queryOne<{
		is_monitor: boolean;
		manages_plants: boolean;
		is_business_manager: boolean;
	}>(
		`SELECT is_monitor, is_business_manager,
		        EXISTS (SELECT 1 FROM plant_manager_assignments WHERE manager_id = $1) AS manages_plants
		 FROM plant_managers WHERE id = $1`,
		[locals.user!.id]
	);
	const isMonitor = manager?.is_monitor ?? false;
	// A monitor that manages no plants of its own sees Attendance, Pumps and People only (for now):
	// Overview, Approvals and Kept photos send it to Attendance.
	const monitorOnly = isMonitor && !manager?.manages_plants;
	// A business manager with no plants of its own (and no Areas) only looks and decides missed
	// days: Regularisations, Attendance, Pumps and People; hooks.server.ts refuses its other changes.
	const businessManagerOnly =
		Boolean(manager?.is_business_manager) && !isMonitor && !manager?.manages_plants;
	if (businessManagerOnly) {
		const path = url.pathname.replace(/\/$/, '');
		const shown = ['regularisations', 'attendance', 'pumps', 'people'].map((p) =>
			resolve(`/plant-manager/${p}` as '/plant-manager/attendance')
		);
		if (!shown.some((p) => path === p || path.startsWith(p + '/')))
			redirect(303, resolve('/plant-manager/regularisations'));
	} else if (monitorOnly) {
		const path = url.pathname.replace(/\/$/, '');
		const hidden = [resolve('/plant-manager/approvals'), resolve('/plant-manager/photo-backups')];
		// A fraud case stays open to them: the attendance log links its fraud warnings there.
		const fraudCase = path.startsWith(resolve('/plant-manager/approvals') + '/fraud/');
		if (
			path === resolve('/plant-manager') ||
			(!fraudCase && hidden.some((p) => path === p || path.startsWith(p + '/')))
		)
			redirect(303, resolve('/plant-manager/attendance'));
	}
	return {
		user: locals.user,
		isMonitor,
		monitorOnly,
		businessManagerOnly,
		navCounts: await loadNavCounts(
			'plant-manager',
			locals.user!.id,
			sectionForPath(url.pathname, {
				attendance: resolve('/plant-manager/attendance'),
				fraud: resolve('/plant-manager/approvals'),
				regularisations: resolve('/plant-manager/regularisations')
			})
		)
	};
};
