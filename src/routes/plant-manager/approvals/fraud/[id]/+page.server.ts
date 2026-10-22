import type { PageServerLoad } from './$types';
import { loadFraudCase } from '$lib/server/fraudCase';

export const load: PageServerLoad = async ({ locals, params }) => ({
	fraudCase: await loadFraudCase('plant-manager', locals.user!.id, params.id)
});
