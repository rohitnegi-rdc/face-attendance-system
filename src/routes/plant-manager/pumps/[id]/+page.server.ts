import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { addDaysStr, isDateKey } from '$lib/date';
import { query, queryOne } from '$lib/server/db';
import { attachSessionEvidence, groupShifts } from '$lib/server/sessionEvidence';
import { todayIST } from '$lib/server/time';

// One pump's day for a plant manager or monitor (View attendance on the Pumps today checklist):
// its status and site, who was counted (full shift / start only / end only) and the shift with its
// start and end photos. Only a pump of the manager's plants (manager_plants); ?day= today or before.
export const load: PageServerLoad = async ({ params, url, locals }) => {
	const managerId = locals.user!.id;
	const today = todayIST();
	const asked = url.searchParams.get('day') ?? '';
	const day = isDateKey(asked) && asked <= today ? asked : today;
	if (!/^[0-9a-f-]{36}$/i.test(params.id)) error(404, 'Pump not found');

	const pump = await queryOne<{
		id: string;
		pump_code: string;
		plant_name: string;
		vendor_name: string;
		work_status: 'active' | 'idle' | 'inactive';
		site_name: string | null;
	}>(
		`SELECT pu.id, pu.pump_code, pl.name AS plant_name, v.name AS vendor_name,
		        COALESCE(st.status, 'inactive') AS work_status,
		        CASE WHEN st.status IN ('active', 'idle') THEN st.site_name END AS site_name
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN vendors v ON v.id = pu.vendor_id
		 LEFT JOIN LATERAL (SELECT ds.status, ds.site_name FROM pump_day_status ds
		   WHERE ds.pump_id = pu.id AND ds.day <= $3 ORDER BY ds.day DESC LIMIT 1) st ON true
		 WHERE pu.id = $1 AND EXISTS (SELECT 1 FROM manager_plants mp
		   WHERE mp.plant_id = pu.plant_id AND mp.manager_id = $2)`,
		[params.id, managerId, day]
	);
	if (!pump) error(404, 'Pump not found');

	const [counts, sessionRows] = await Promise.all([
		queryOne<{ full: number; start_only: number; end_only: number }>(
			`SELECT count(*) FILTER (WHERE morning_matched AND evening_matched)::int AS full,
			        count(*) FILTER (WHERE morning_matched AND NOT evening_matched)::int AS start_only,
			        count(*) FILTER (WHERE evening_matched AND NOT morning_matched)::int AS end_only
			 FROM daily_person_attendance WHERE pump_id = $1 AND session_date = $2`,
			[pump.id, day]
		),
		query<any>(
			`SELECT s.id, s.session_date, s.session_type, s.status, s.submitted_at, s.photo_url,
			        s.pairing_status, s.closed_by, s.error_reason, s.location_status, s.gps_lat, s.gps_lng,
			        pu.id AS pump_id, pu.pump_code, pl.name AS plant_name,
			        EXISTS (
			          SELECT 1 FROM attendance_review_flags arf
			          WHERE arf.session_id = s.id AND arf.person_id IS NULL AND arf.status = 'open'
			        ) AS group_flagged
			 FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
			 JOIN plants pl ON pl.id = pu.plant_id
			 WHERE s.pump_id = $1 AND s.session_date = $2
			 ORDER BY s.submitted_at`,
			[pump.id, day]
		)
	]);

	return {
		pump,
		day,
		today,
		yesterday: addDaysStr(today, -1),
		counts: counts ?? { full: 0, start_only: 0, end_only: 0 },
		shifts: groupShifts(await attachSessionEvidence(sessionRows))
	};
};
