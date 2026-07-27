import type { PageServerLoad } from './$types';
import { query, queryOne } from '$lib/server/db';
import { error } from '@sveltejs/kit';

export const load: PageServerLoad = async ({ params }) => {
	const person = await queryOne<any>(
		`SELECT p.id, p.display_seq, p.first_seen_at, p.last_seen_at, p.status,
		        pu.id AS pump_id, pu.pump_code
		 FROM persons p JOIN pumps pu ON pu.id = p.pump_id
		 WHERE p.id = $1`,
		[params.id]
	);
	if (!person) throw error(404, 'person not found');

	const history = await query<any>(
		`SELECT session_date, morning_matched, evening_matched, morning_confidence, evening_confidence
		 FROM daily_person_attendance
		 WHERE person_id = $1
		 ORDER BY session_date DESC LIMIT 90`,
		[params.id]
	);

	const yearly = await query<any>(
		`SELECT year, days_present, days_morning_only, days_evening_only
		 FROM person_attendance_yearly WHERE person_id = $1 ORDER BY year DESC`,
		[params.id]
	);

	return { person, history, yearly };
};
