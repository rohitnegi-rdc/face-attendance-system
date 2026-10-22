import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { issueTemporaryPassword } from '$lib/server/passwordReset';
import { query } from '$lib/server/db';
import { todayIST } from '$lib/server/time';

export const load: PageServerLoad = async ({ locals }) => ({
	pumps: await query<any>(
		`SELECT pu.id, pu.pump_code, pu.login_email, pl.name AS plant_name, a.name AS area_name,
		        latest.submitted_at, latest.session_type, latest.status,
		        COALESCE(ROUND(100.0 * COUNT(dpa.id) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched)
		        / NULLIF(COUNT(dpa.id), 0), 0), 0)::int AS attendance_pct
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		 JOIN plant_manager_assignments pma ON pma.plant_id = pl.id AND pma.manager_id = $1
		 LEFT JOIN daily_person_attendance dpa ON dpa.pump_id = pu.id AND dpa.session_date BETWEEN $2::date - interval '29 days' AND $2::date
		 LEFT JOIN LATERAL (SELECT submitted_at, session_type, status FROM attendance_sessions
		   WHERE pump_id = pu.id ORDER BY submitted_at DESC LIMIT 1) latest ON true
		 GROUP BY pu.id, pl.name, a.name, latest.submitted_at, latest.session_type, latest.status
		 ORDER BY a.name, pl.name, pu.pump_code`,
		[locals.user!.id, todayIST()]
	)
});

export const actions: Actions = {
	// Only pumps of this manager's own plants.
	resetPumpPassword: async ({ request, locals }) => {
		const id = String((await request.formData()).get('id') || '').trim();
		const [pump] = /^[0-9a-f-]{36}$/i.test(id)
			? await query<{ id: string }>(
					`SELECT pu.id FROM pumps pu
					 JOIN plant_manager_assignments pma ON pma.plant_id = pu.plant_id AND pma.manager_id = $2
					 WHERE pu.id = $1`,
					[id, locals.user!.id]
				)
			: [];
		const issued = pump
			? await issueTemporaryPassword('pump', pump.id, {
					role: 'plant-manager',
					id: locals.user!.id
				})
			: null;
		if (!issued) return fail(404, { message: 'This pump is not in your plants.' });
		return { success: true, credentials: issued };
	}
};
