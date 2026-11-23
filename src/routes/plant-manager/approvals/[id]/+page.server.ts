import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { queryOne } from '$lib/server/db';
import { decideLocation, type LocationDecision } from '$lib/server/locationDecision';
import { LOCATION_RADIUS_M, locationIssueText } from '$lib/server/locationCheck';
import { resolve } from '$app/paths';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only sessions at plants assigned to this manager; anything else is a 404, not a 403, so the
// page does not confirm that a session id exists.
async function loadSession(id: string, managerId: string) {
	if (!UUID.test(id)) return null;
	return queryOne<any>(
		`SELECT s.id, s.session_date::text AS session_date, s.status, s.location_status,
		        s.location_issue, s.location_distance_m, s.location_note,
		        s.gps_lat, s.gps_lng, s.pump_gps_lat, s.pump_gps_lng, s.pump_gps_at,
		        to_char(s.submitted_at AT TIME ZONE 'Asia/Kolkata', 'DD-MM-YYYY, HH12:MI am') AS sent_at,
		        to_char(s.pump_gps_at AT TIME ZONE 'Asia/Kolkata', 'DD-MM-YYYY, HH12:MI am') AS pump_gps_time,
		        to_char(s.location_decided_at AT TIME ZONE 'Asia/Kolkata', 'DD-MM-YYYY, HH12:MI am') AS decided_at,
		        pu.pump_code, pl.name AS plant_name, pm.name AS decided_by,
		        (SELECT count(*)::int FROM attendance_face_evidence e WHERE e.session_id = s.id) AS faces
		 FROM attendance_sessions s
		 JOIN pumps pu ON pu.id = s.pump_id JOIN plants pl ON pl.id = pu.plant_id
		 JOIN manager_plants pma ON pma.plant_id = pl.id AND pma.manager_id = $2
		 LEFT JOIN plant_managers pm ON pm.id = s.location_decided_by
		 WHERE s.id = $1 AND s.location_status IS NOT NULL`,
		[id, managerId]
	);
}

export const load: PageServerLoad = async ({ params, locals }) => {
	const session = await loadSession(params.id, locals.user!.id);
	if (!session) throw error(404, 'Approval not found');
	return {
		session: {
			...session,
			reason: locationIssueText(
				session.location_issue,
				session.location_distance_m,
				session.pump_gps_at
			),
			photoUrl: resolve('/api/attendance/photo/[id]', { id: session.id })
		},
		radius: LOCATION_RADIUS_M
	};
};

async function decide(
	params: { id: string },
	locals: App.Locals,
	request: Request,
	decision: LocationDecision
) {
	const form = await request.formData();
	const session = await loadSession(params.id, locals.user!.id);
	if (!session) throw error(404, 'Approval not found');
	const result = await decideLocation(
		session.id,
		locals.user!.id,
		decision,
		form.get('note'),
		'app'
	);
	if (!result.ok) return fail(result.status, { error: result.error });
	return { decided: decision };
}

export const actions: Actions = {
	approve: ({ params, locals, request }) => decide(params, locals, request, 'approved'),
	reject: ({ params, locals, request }) => decide(params, locals, request, 'rejected')
};
