import type { PageServerLoad } from './$types';
import { query } from '$lib/server/db';

export const load: PageServerLoad = async ({ locals }) => {
	const vendorId = locals.user!.id;

	const pumps = await query<any>(
		`SELECT pu.id, pu.pump_code, pl.name AS plant_name, a.name AS area_name
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		 WHERE pu.vendor_id = $1 ORDER BY a.name, pl.name, pu.pump_code`,
		[vendorId]
	);

	const persons = await query<any>(
		`SELECT p.id, p.pump_id, p.display_seq, pu.pump_code, p.first_seen_at, p.last_seen_at,
		        COUNT(dpa.id) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched) AS days_present
		 FROM persons p
		 JOIN pumps pu ON pu.id = p.pump_id
		 LEFT JOIN daily_person_attendance dpa ON dpa.person_id = p.id
		 WHERE pu.vendor_id = $1 AND p.status = 'active'
		 GROUP BY p.id, p.pump_id, p.display_seq, pu.pump_code
		 ORDER BY p.last_seen_at DESC`,
		[vendorId]
	);

	return { pumps, persons };
};
