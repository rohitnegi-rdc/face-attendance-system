import type { LayoutServerLoad } from './$types';
import { resolve } from '$app/paths';
import { isFraudCheckDisabled } from '$lib/server/settings';
import { loadNavCounts } from '$lib/server/navCounts';

// Every admin page warns while the cross-pump fraud check is off (test mode only).
// navCounts: the side navigation badges, refreshed on every navigation and by AppShell's timer.
export const load: LayoutServerLoad = async ({ locals, url, depends }) => {
	depends('app:nav-counts');
	return {
		fraudCheckDisabled: await isFraudCheckDisabled(),
		navCounts: await loadNavCounts(
			'admin',
			locals.user!.id,
			url.pathname === resolve('/admin/attendance')
		)
	};
};
