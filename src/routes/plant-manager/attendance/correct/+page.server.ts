import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { resolve } from '$app/paths';
import { query, queryOne } from '$lib/server/db';
import { isDateKey } from '$lib/date';
import { saveCorrection } from '$lib/server/attendanceCorrection';
import { logger } from '$lib/server/log';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The plant manager marks a worker present (or not) for one day at a pump of their plants, for
// example when the pump missed the shift start. Same rules and history as the admin's page.
export const load: PageServerLoad = async ({ url, locals }) => {
	const managerId = locals.user!.id;
	const pumpId = url.searchParams.get('pump') || '';
	const day = url.searchParams.get('day') || '';
	if (!UUID_PATTERN.test(pumpId) || !isDateKey(day))
		redirect(303, resolve('/plant-manager/attendance'));

	const pump = await queryOne<any>(
		`SELECT pu.id, pu.pump_code, pl.name AS plant_name, v.name AS vendor_name
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN vendors v ON v.id = pu.vendor_id
		 JOIN plant_manager_assignments pma ON pma.plant_id = pu.plant_id
		 WHERE pu.id = $1 AND pma.manager_id = $2`,
		[pumpId, managerId]
	);
	if (!pump) error(404, 'Pump not found');

	const [sessions, people, corrections] = await Promise.all([
		query<any>(
			`SELECT id, session_type, status,
			        to_char(submitted_at AT TIME ZONE 'Asia/Kolkata', 'HH12:MI am') AS sent_time,
			        photo_url IS NOT NULL AS has_photo
			 FROM attendance_sessions WHERE pump_id = $1 AND session_date = $2
			   AND status IN ('review', 'completed')
			 ORDER BY submitted_at`,
			[pumpId, day]
		),
		// Not fully present first: those are the ones a manager comes here to fix.
		query<any>(
			`SELECT p.id, p.display_seq, p.name, p.is_operator,
			        COALESCE(dpa.morning_matched, false) AS morning_matched,
			        COALESCE(dpa.evening_matched, false) AS evening_matched
			 FROM persons p
			 LEFT JOIN daily_person_attendance dpa ON dpa.person_id = p.id AND dpa.session_date = $2
			 WHERE p.pump_id = $1 AND p.status = 'active'
			 ORDER BY COALESCE(dpa.morning_matched AND dpa.evening_matched, false), p.name NULLS LAST,
			          p.display_seq`,
			[pumpId, day]
		),
		query<any>(
			`SELECT ac.id, p.display_seq, p.name, ac.reason, ac.corrected_morning_matched,
			        ac.corrected_evening_matched, coalesce(adm.email, pm.name) AS corrected_by,
			        to_char(ac.corrected_at AT TIME ZONE 'Asia/Kolkata', 'Dy, DD Mon YYYY, HH12:MI am') AS corrected_at
			 FROM attendance_corrections ac JOIN persons p ON p.id = ac.person_id
			 LEFT JOIN admins adm ON adm.id = ac.corrected_by_admin_id
			 LEFT JOIN plant_managers pm ON pm.id = ac.corrected_by_manager_id
			 WHERE ac.pump_id = $1 AND ac.session_date = $2 ORDER BY ac.corrected_at DESC LIMIT 20`,
			[pumpId, day]
		)
	]);
	return { pump, day, sessions, people, corrections };
};

export const actions: Actions = {
	correct: async ({ request, locals }) => {
		try {
			const result = await saveCorrection(
				{ role: 'plant-manager', id: locals.user!.id },
				await request.formData()
			);
			if (result.error)
				return fail(result.status, { error: result.error, personId: result.personId });
			return { success: true, personId: result.personId, message: 'Attendance saved' };
		} catch (err) {
			logger.error(
				{ error: String((err as any)?.message || err) },
				'plant manager correction failed'
			);
			return fail(500, { error: 'Could not save the attendance correction' });
		}
	}
};
