import type { LayoutServerLoad } from './$types';
import { resolve } from '$app/paths';
import { getTestMode } from '$lib/server/settings';
import { loadNavCounts, sectionForPath } from '$lib/server/navCounts';

// Every admin page warns while test mode is on (fraud check off, alert emails not sent).
// navCounts: the side navigation badges, refreshed on every navigation and by AppShell's timer.
export const load: LayoutServerLoad = async ({ locals, url, depends }) => {
	depends('app:nav-counts');
	return {
		testMode: await getTestMode(),
		navCounts: await loadNavCounts(
			'admin',
			locals.user!.id,
			sectionForPath(url.pathname, {
				attendance: resolve('/admin/attendance'),
				fraud: resolve('/admin/fraud-flags')
			})
		)
	};
};
