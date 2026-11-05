// The phone's position for a shift photo (src/routes/pump/+page.svelte), the decisions only, so they
// can be unit tested (tests/unit/pumpLocation.test.ts). Asked while uploading: a phone that closes
// the browser's question is asked again, a phone that allowed is never asked (the browser remembers).
// It never stops the photo: a browser set to Block shows no question and no code can bring it back.

// Asks per upload, in case a browser refuses without showing a question; the next upload asks again.
export const MAX_LOCATION_ASKS = 3;

const PERMISSION_DENIED = 1;

const OPTIONS: PositionOptions = { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 };

export async function askForPosition(
	geolocation: Pick<Geolocation, 'getCurrentPosition'> | undefined,
	// The browser's permission state, null where it cannot be read.
	permissionState: () => Promise<PermissionState | null>
): Promise<GeolocationPosition | null> {
	if (!geolocation) return null;
	for (let ask = 0; ask < MAX_LOCATION_ASKS; ask++) {
		const answer = await new Promise<GeolocationPosition | GeolocationPositionError>((done) =>
			geolocation.getCurrentPosition(done, done, OPTIONS)
		);
		if ('coords' in answer) return answer;
		// Allowed but no position (no signal, timed out): asking again would not help.
		if (answer.code !== PERMISSION_DENIED) return null;
		const state = await permissionState();
		if (state === 'denied' || state === 'granted') return null;
	}
	return null;
}
