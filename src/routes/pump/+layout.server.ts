import type { LayoutServerLoad } from './$types';
import { queryOne } from '$lib/server/db';

// The first sign-in guide opens until the pump finishes it once (PumpGuide.svelte).
export const load: LayoutServerLoad = async ({ locals }) => {
	if (locals.user?.role !== 'pump') return { guideDone: true };
	const pump = await queryOne<{ done: boolean }>(
		'SELECT guide_done_at IS NOT NULL AS done FROM pumps WHERE id = $1',
		[locals.user.id]
	);
	return { guideDone: pump?.done ?? true };
};
