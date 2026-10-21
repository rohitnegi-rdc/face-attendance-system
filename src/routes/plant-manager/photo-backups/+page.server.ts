import type { PageServerLoad } from './$types';
import { listPhotoBackups } from '$lib/server/photoBackups';

export const load: PageServerLoad = async ({ locals }) => ({
	items: await listPhotoBackups(locals.user!.id)
});
