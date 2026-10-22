import type { LayoutServerLoad } from './$types';
import { resolve } from '$app/paths';
import { loadNavCounts, sectionForPath } from '$lib/server/navCounts';

// navCounts: the side navigation badges, refreshed on every navigation and by AppShell's timer.
export const load: LayoutServerLoad = async ({ locals, url, depends }) => {
	depends('app:nav-counts');
	return {
		user: locals.user,
		navCounts: await loadNavCounts(
			'plant-manager',
			locals.user!.id,
			sectionForPath(url.pathname, {
				attendance: resolve('/plant-manager/attendance'),
				fraud: resolve('/plant-manager/approvals')
			})
		)
	};
};
