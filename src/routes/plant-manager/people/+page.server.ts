import type { PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { shiftStillOpen } from '$lib/server/shiftSessions';

export const load: PageServerLoad = async ({ locals, url }) => {
	const requestedPump = url.searchParams.get('pump') || '';
	const pump = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedPump) ? requestedPump : '';
	const [pumps, persons] = await Promise.all([
		query<any>(`SELECT pu.id, pu.pump_code FROM pumps pu JOIN plant_manager_assignments pma ON pma.plant_id = pu.plant_id WHERE pma.manager_id = $1 ORDER BY pu.pump_code`, [locals.user!.id]),
		query<any>(
			`SELECT p.id, p.display_seq, p.name, p.is_operator, p.first_seen_at, p.last_seen_at, pu.pump_code,
			        COUNT(dpa.id) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched)::int AS days_present,
			        COUNT(dpa.id) FILTER (WHERE dpa.morning_matched AND NOT dpa.evening_matched AND NOT ${shiftStillOpen('dpa')})::int AS days_morning_only,
			        COUNT(dpa.id) FILTER (WHERE NOT dpa.morning_matched AND dpa.evening_matched)::int AS days_evening_only
			 FROM persons p JOIN pumps pu ON pu.id = p.pump_id
			 JOIN plant_manager_assignments pma ON pma.plant_id = pu.plant_id
			 LEFT JOIN daily_person_attendance dpa ON dpa.person_id = p.id
			 WHERE pma.manager_id = $1 AND p.status = 'active' AND ($2 = '' OR pu.id = $2::uuid)
			 GROUP BY p.id, pu.pump_code ORDER BY p.last_seen_at DESC`, [locals.user!.id, pump]
		)
	]);
	return { pumps, persons, pump };
};
