import type { LayoutServerLoad } from './$types';
import { isFraudCheckDisabled } from '$lib/server/settings';

// Every admin page warns while the cross-pump fraud check is off (test mode only).
export const load: LayoutServerLoad = async () => ({
	fraudCheckDisabled: await isFraudCheckDisabled()
});
