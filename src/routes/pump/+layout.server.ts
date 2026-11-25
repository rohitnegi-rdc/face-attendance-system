import type { LayoutServerLoad } from './$types';
import { queryOne } from '$lib/server/db';

// The first sign-in guide opens until the pump finishes it once (PumpGuide.svelte). The screen
// opens in English when the pump's Area is ticked for it at /admin/settings (areas.pump_english).
export const load: LayoutServerLoad = async ({ locals }) => {
	if (locals.user?.role !== 'pump') return { guideDone: true, english: false };
	const pump = await queryOne<{ done: boolean; english: boolean }>(
		`SELECT p.guide_done_at IS NOT NULL AS done, COALESCE(a.pump_english, false) AS english
		 FROM pumps p LEFT JOIN plants pl ON pl.id = p.plant_id LEFT JOIN areas a ON a.id = pl.area_id
		 WHERE p.id = $1`,
		[locals.user.id]
	);
	return { guideDone: pump?.done ?? true, english: pump?.english ?? false };
};
