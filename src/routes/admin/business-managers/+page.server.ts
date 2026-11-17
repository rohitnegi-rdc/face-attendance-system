import type { PageServerLoad } from './$types';
import { roleAdminActions, roleAdminLoad } from '$lib/server/businessRoleAdmin';

// Business managers approve missed days (regularisations) for their plants, one per plant. A plant
// without one sends its requests to the admins. The list can be uploaded as a CSV (same columns as
// db/migrations/049_business_managers.csv) or changed one plant at a time.
export const load: PageServerLoad = roleAdminLoad('manager');
export const actions = roleAdminActions('manager');
