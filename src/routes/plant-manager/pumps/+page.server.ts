import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { issueTemporaryPassword } from '$lib/server/passwordReset';
import { query } from '$lib/server/db';
import { todayIST } from '$lib/server/time';
import { countsAsFraud } from '$lib/server/fraudCount';

// Only the pumps Active or Idle today (pump_day_status), each with that status and whether anyone
// is counted today, so the page colours rows like the admin Area list.
export const load: PageServerLoad = async ({ locals }) => ({
	pumps: await query<any>(
		`SELECT pu.id, pu.pump_code, pu.login_email, pl.name AS plant_name, a.name AS area_name,
		        latest.submitted_at, latest.session_type, latest.status, st.status AS work_status,
		        (SELECT count(*) FROM daily_person_attendance t
		          WHERE t.pump_id = pu.id AND t.session_date = $2)::int AS today_total,
		        (SELECT count(*) FROM fraud_flags ff JOIN attendance_sessions s ON s.id = ff.session_id
		          WHERE s.pump_id = pu.id AND s.session_date = $2 AND ${countsAsFraud('ff')})::int AS today_fraud,
		        COALESCE(ROUND(100.0 * COUNT(dpa.id) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched)
		        / NULLIF(COUNT(dpa.id), 0), 0), 0)::int AS attendance_pct
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		 JOIN manager_plants pma ON pma.plant_id = pl.id AND pma.manager_id = $1
		 JOIN LATERAL (SELECT ds.status FROM pump_day_status ds
		   WHERE ds.pump_id = pu.id AND ds.day <= $2 ORDER BY ds.day DESC LIMIT 1) st
		   ON st.status IN ('active', 'idle')
		 LEFT JOIN daily_person_attendance dpa ON dpa.pump_id = pu.id AND dpa.session_date BETWEEN $2::date - interval '29 days' AND $2::date
		 LEFT JOIN LATERAL (SELECT submitted_at, session_type, status FROM attendance_sessions
		   WHERE pump_id = pu.id ORDER BY submitted_at DESC LIMIT 1) latest ON true
		 GROUP BY pu.id, pl.name, a.name, latest.submitted_at, latest.session_type, latest.status, st.status
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
					 JOIN manager_plants pma ON pma.plant_id = pu.plant_id AND pma.manager_id = $2
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
