import type { PageServerLoad } from './$types';
import { roleAdminActions, roleAdminLoad } from '$lib/server/businessRoleAdmin';

// Business heads (migration 051): one per plant, they see their plants read only and are copied on
// the 9 am attendance email of their plants' Areas. The list can be uploaded as a CSV (same columns
// as db/migrations/052_business_heads.csv) or changed one plant at a time.
export const load: PageServerLoad = roleAdminLoad('head');
export const actions = roleAdminActions('head');
