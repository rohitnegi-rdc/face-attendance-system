// Pump GPS words shared by the admin pump page and the Pump GPS page: how old a position is, whether
// the shift start check can use it (src/lib/server/locationCheck.ts, PUMP_GPS_MAX_AGE_MINUTES), and
// the Google Maps link for a position.

export type GpsState = 'fresh' | 'old' | 'none';

// "just now", "12 min ago", "2 h 5 min ago", "38 days ago".
export function gpsAgo(minutes: number): string {
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	if (minutes < 1440) {
		const m = minutes % 60;
		return `${Math.floor(minutes / 60)} h${m ? ` ${m} min` : ''} ago`;
	}
	const days = Math.floor(minutes / 1440);
	return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function gpsState(ageMinutes: number | null | undefined, maxAgeMinutes: number): GpsState {
	if (ageMinutes === null || ageMinutes === undefined) return 'none';
	return ageMinutes <= maxAgeMinutes ? 'fresh' : 'old';
}

export const GPS_STATE_LABEL: Record<GpsState, string> = {
	fresh: 'Fresh',
	old: 'Too old',
	none: 'No GPS'
};

// Opens Google Maps at the position (the documented search URL; works in the app on phones).
export function mapsUrl(lat: number, lng: number): string {
	return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
