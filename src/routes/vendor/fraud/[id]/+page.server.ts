import type { PageServerLoad } from './$types';
import { loadFraudCase } from '$lib/server/fraudCase';

export const load: PageServerLoad = async ({ locals, params }) => ({
	fraudCase: await loadFraudCase('vendor', locals.user!.id, params.id)
});
