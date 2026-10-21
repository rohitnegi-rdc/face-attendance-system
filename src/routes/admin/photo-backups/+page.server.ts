import type { PageServerLoad } from './$types';
import { listPhotoBackups } from '$lib/server/photoBackups';

export const load: PageServerLoad = async () => ({ items: await listPhotoBackups(null) });
