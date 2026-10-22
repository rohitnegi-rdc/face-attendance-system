import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { shiftStillOpen } from '$lib/server/shiftSessions';
import { renamePerson } from '$lib/server/personNames';

export const load: PageServerLoad = async ({ locals, url }) => {
	const vendorId = locals.user!.id;
	const requestedPump = url.searchParams.get('pump') || '';
	const pump = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		requestedPump
	)
		? requestedPump
		: '';
	// Names only; the face loads when opened (/api/persons/[id]/face).
	const [pumps, persons] = await Promise.all([
		query<any>('SELECT id, pump_code FROM pumps WHERE vendor_id = $1 ORDER BY pump_code', [
			vendorId
		]),
		query<any>(
			`SELECT p.id, p.display_seq, p.name, p.is_operator, p.first_seen_at, p.last_seen_at, pu.pump_code,
			        COUNT(dpa.id) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched) AS days_present,
			        COUNT(dpa.id) FILTER (WHERE dpa.morning_matched AND NOT dpa.evening_matched AND NOT ${shiftStillOpen('dpa')}) AS days_morning_only,
			        COUNT(dpa.id) FILTER (WHERE NOT dpa.morning_matched AND dpa.evening_matched) AS days_evening_only
			 FROM persons p JOIN pumps pu ON pu.id = p.pump_id
			 LEFT JOIN daily_person_attendance dpa ON dpa.person_id = p.id
			 WHERE pu.vendor_id = $1 AND p.status = 'active' AND ($2 = '' OR pu.id = $2::uuid)
			 GROUP BY p.id, pu.pump_code
			 ORDER BY p.last_seen_at DESC`,
			[vendorId, pump]
		)
	]);
	return { pumps, persons, pump };
};

export const actions: Actions = {
	// The vendor corrects a name the operator wrote.
	rename: async ({ request, locals }) => {
		const form = await request.formData();
		const personId = String(form.get('person_id') || '');
		const result = await renamePerson(
			{ role: 'vendor', id: locals.user!.id },
			personId,
			form.get('name')
		);
		if (result.error) return fail(result.status, { error: result.error, personId });
		return { renamed: personId, name: result.name };
	}
};
