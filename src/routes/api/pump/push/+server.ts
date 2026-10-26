import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pool } from '$lib/server/db';
import { pushPublicKey, validEndpoint } from '$lib/server/push';

// Shift end reminders (migration 040): the pump screen asks for the public key, lets the phone
// subscribe, and saves the subscription here. A phone that moves to another pump login follows it.
function pumpId(locals: App.Locals) {
	return locals.user?.role === 'pump' ? locals.user.id : null;
}

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!pumpId(locals)) return json({ error: 'Forbidden' }, { status: 403 });
	return json({ publicKey: await pushPublicKey(url.origin) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const pump = pumpId(locals);
	if (!pump) return json({ error: 'Forbidden' }, { status: 403 });
	const body = await request.json().catch(() => null);
	const p256dh = body?.keys?.p256dh;
	const auth = body?.keys?.auth;
	if (
		!validEndpoint(body?.endpoint) ||
		typeof p256dh !== 'string' ||
		typeof auth !== 'string' ||
		p256dh.length > 200 ||
		auth.length > 100
	) {
		return json({ error: 'Not a push subscription' }, { status: 400 });
	}
	await pool.query(
		`INSERT INTO push_subscriptions (pump_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
		 ON CONFLICT (endpoint) DO UPDATE
		 SET pump_id = EXCLUDED.pump_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
		[pump, body.endpoint, p256dh, auth]
	);
	return json({ ok: true });
};
