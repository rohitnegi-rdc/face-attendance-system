import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { issueTemporaryPassword } from '$lib/server/passwordReset';
import { query } from '$lib/server/db';
import { todayIST } from '$lib/server/time';
import { countsAsFraud } from '$lib/server/fraudCount';

// Only the pumps Active or Idle today (pump_day_status), each with that status, today's site, who is
// counted today (full shift / start only / end only), its latest photo and 30-day attendance. The
// page shows one card per pump; the plant and Area show only when the manager has more than one.
export const load: PageServerLoad = async ({ locals }) => {
	const today = todayIST();
	const pumps = await query<any>(
		`SELECT pu.id, pu.pump_code, pu.login_email, pl.id AS plant_id, pl.name AS plant_name,
		        a.id AS area_id, a.name AS area_name, st.status AS work_status, st.site_name,
		        latest.submitted_at, latest.session_type, latest.status, latest.pairing_status,
		        tc.full_shift, tc.start_only, tc.end_only,
		        (SELECT count(*) FROM fraud_flags ff JOIN attendance_sessions s ON s.id = ff.session_id
		          WHERE s.pump_id = pu.id AND s.session_date = $2 AND ${countsAsFraud('ff')})::int AS today_fraud,
		        COALESCE((SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE d.morning_matched AND d.evening_matched)
		                  / NULLIF(COUNT(*), 0))
		           FROM daily_person_attendance d
		           WHERE d.pump_id = pu.id
		             AND d.session_date BETWEEN $2::date - interval '29 days' AND $2::date), 0)::int AS attendance_pct
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		 JOIN manager_plants pma ON pma.plant_id = pl.id AND pma.manager_id = $1
		 JOIN LATERAL (SELECT ds.status, ds.site_name FROM pump_day_status ds
		   WHERE ds.pump_id = pu.id AND ds.day <= $2 ORDER BY ds.day DESC LIMIT 1) st
		   ON st.status IN ('active', 'idle')
		 CROSS JOIN LATERAL (
		   SELECT count(*) FILTER (WHERE t.morning_matched AND t.evening_matched)::int AS full_shift,
		          count(*) FILTER (WHERE t.morning_matched AND NOT t.evening_matched)::int AS start_only,
		          count(*) FILTER (WHERE t.evening_matched AND NOT t.morning_matched)::int AS end_only
		   FROM daily_person_attendance t WHERE t.pump_id = pu.id AND t.session_date = $2) tc
		 LEFT JOIN LATERAL (SELECT submitted_at, session_type, status, pairing_status FROM attendance_sessions
		   WHERE pump_id = pu.id ORDER BY submitted_at DESC LIMIT 1) latest ON true
		 ORDER BY a.name, pl.name, pu.pump_code`,
		[locals.user!.id, today]
	);
	return {
		pumps: pumps.map((p) => ({ ...p, today_total: p.full_shift + p.start_only + p.end_only })),
		plantCount: new Set(pumps.map((p) => p.plant_id)).size,
		areaCount: new Set(pumps.map((p) => p.area_id)).size
	};
};

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
