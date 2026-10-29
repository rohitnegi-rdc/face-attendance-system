import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { renamePerson, type RenameActor } from '$lib/server/personNames';

// Rename a worker from the face popup on the session logs: the admin, the plant manager (their
// plants) and the vendor (their pumps), with the same rules as everywhere else (personNames.ts).
export const POST: RequestHandler = async ({ params, locals, request }) => {
	const role = locals.user?.role;
	if (!locals.user || (role !== 'admin' && role !== 'plant-manager' && role !== 'vendor'))
		return json({ error: 'Forbidden' }, { status: 403 });
	const body = await request.json().catch(() => ({}));
	const actor: RenameActor = { role, id: locals.user.id };
	const result = await renamePerson(actor, params.id, body?.name);
	if (result.error) return json({ error: result.error }, { status: result.status });
	return json({ name: result.name });
};
