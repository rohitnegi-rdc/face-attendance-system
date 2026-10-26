// Web Push for shift end reminders (migration 040, sent by worker/endReminders.js). The VAPID key
// pair is made here on first use and kept in push_keys, so push needs no server setting.
import webpush from 'web-push';
import { query } from '$lib/server/db';

// Push services may contact the subject: the site's own https address, or (local and test
// runs over http) a mailto, since web-push accepts nothing else.
function subjectFor(origin: string) {
	return origin.startsWith('https://') ? origin : 'mailto:admin@attendance.rdc';
}

export async function pushPublicKey(origin: string): Promise<string> {
	const [existing] = await query<{ public_key: string }>('SELECT public_key FROM push_keys');
	if (existing) return existing.public_key;
	const keys = webpush.generateVAPIDKeys();
	// Two first requests at once: one insert wins, both read the winner.
	await query(
		`INSERT INTO push_keys (public_key, private_key, subject) VALUES ($1, $2, $3)
		 ON CONFLICT (id) DO NOTHING`,
		[keys.publicKey, keys.privateKey, subjectFor(origin)]
	);
	const [stored] = await query<{ public_key: string }>('SELECT public_key FROM push_keys');
	return stored.public_key;
}

// The push service address a phone gives. Only https: the worker posts to it, so an internal
// address must never get in. Regression runs allow their local stand-in.
export function validEndpoint(endpoint: unknown): endpoint is string {
	if (typeof endpoint !== 'string' || endpoint.length > 2000) return false;
	try {
		const url = new URL(endpoint);
		if (url.protocol === 'https:') return true;
		return (
			process.env.PUSH_TEST_ENDPOINTS === 'true' &&
			url.protocol === 'http:' &&
			url.hostname === '127.0.0.1'
		);
	} catch {
		return false;
	}
}
