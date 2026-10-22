import type { LayoutServerLoad } from './$types';
import { resolve } from '$app/paths';
import { loadNavCounts } from '$lib/server/navCounts';

// navCounts: the side navigation badges, refreshed on every navigation and by AppShell's timer.
export const load: LayoutServerLoad = async ({ locals, url, depends }) => {
	depends('app:nav-counts');
	return {
		navCounts: await loadNavCounts(
			'vendor',
			locals.user!.id,
			url.pathname === resolve('/vendor/attendance')
		)
	};
};
