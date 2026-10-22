import type { PageServerLoad } from './$types';
import { listOpenFraud } from '$lib/server/navCounts';

// Open cross-pump fraud cases on this vendor's pumps (either side of the pair), read only.
export const load: PageServerLoad = async ({ locals }) => ({
	cases: await listOpenFraud('vendor', locals.user!.id)
});
