// The daily checklist of a plant manager or monitor (plant-manager Overview): every pump they can
// see for one day, what needs a look, and who marked it Checked (pump_day_checks). The 8 pm email
// to monitors (worker/monitorDigest.js) names the same problems.
import { query, queryOne } from '$lib/server/db';

export type PumpCheck = {
	pumpId: string;
	pumpCode: string;
	plantName: string;
	areaName: string;
	vendorName: string;
	startAt: string | null;
	endAt: string | null;
	present: number;
	total: number;
	fraud: number;
	// What needs a look, worst first; empty when the day is a full shift for everyone.
	problems: string[];
	check: { by: string; at: string; note: string | null } | null;
};

// A pump's problems for `day`. A start with no end is a problem only once the day is over, or
// after 8 pm on the day itself (`late`): before that the crew is still at work.
export function pumpProblems(
	row: {
		startAt: unknown;
		endAt: unknown;
		failed: number;
		fraud: number;
		present: number;
		total: number;
	},
	late: boolean
) {
	const problems: string[] = [];
	if (row.fraud) problems.push(`${row.fraud} fraud`);
	if (row.failed) problems.push('Photo failed');
	if (!row.startAt && !row.endAt) problems.push('No photo');
	else if (!row.startAt) problems.push('No start photo');
	else if (!row.endAt && late) problems.push('No end photo');
	const short = row.total - row.present;
	if (row.endAt && short > 0) problems.push(`${short} not a full shift`);
	return problems;
}

export async function dayChecklist(managerId: string, day: string, late: boolean) {
	const rows = await query<any>(
		`SELECT pu.id, pu.pump_code, pl.name AS plant_name, a.name AS area_name, v.name AS vendor_name,
		        (SELECT min(s.submitted_at) FROM attendance_sessions s WHERE s.pump_id = pu.id
		          AND s.session_date = $2 AND s.session_type = 'morning' AND s.status <> 'failed') AS start_at,
		        (SELECT max(s.submitted_at) FROM attendance_sessions s WHERE s.pump_id = pu.id
		          AND s.session_date = $2 AND s.session_type = 'evening' AND s.status <> 'failed') AS end_at,
		        (SELECT count(*) FROM attendance_sessions s WHERE s.pump_id = pu.id AND s.session_date = $2
		          AND s.status = 'failed' AND NOT EXISTS (SELECT 1 FROM attendance_sessions ok
		            WHERE ok.pump_id = pu.id AND ok.session_date = $2
		              AND ok.session_type = s.session_type AND ok.status <> 'failed')) AS failed,
		        (SELECT count(*) FILTER (WHERE morning_matched AND evening_matched) FROM daily_person_attendance
		          WHERE pump_id = pu.id AND session_date = $2) AS present,
		        (SELECT count(*) FROM daily_person_attendance
		          WHERE pump_id = pu.id AND session_date = $2) AS total,
		        (SELECT count(*) FROM fraud_flags ff JOIN attendance_sessions s ON s.id = ff.session_id
		          WHERE s.pump_id = pu.id AND s.session_date = $2) AS fraud,
		        pdc.checked_at, pdc.note, coalesce(pm.name, adm.email) AS checked_by
		 FROM manager_plants mp JOIN pumps pu ON pu.plant_id = mp.plant_id
		 JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		 JOIN vendors v ON v.id = pu.vendor_id
		 LEFT JOIN pump_day_checks pdc ON pdc.pump_id = pu.id AND pdc.session_date = $2
		 LEFT JOIN plant_managers pm ON pm.id = pdc.checked_by_manager_id
		 LEFT JOIN admins adm ON adm.id = pdc.checked_by_admin_id
		 WHERE mp.manager_id = $1`,
		[managerId, day]
	);
	const pumps: PumpCheck[] = rows.map((row) => {
		const counts = {
			startAt: row.start_at,
			endAt: row.end_at,
			failed: Number(row.failed),
			fraud: Number(row.fraud),
			present: Number(row.present),
			total: Number(row.total)
		};
		return {
			pumpId: row.id,
			pumpCode: row.pump_code,
			plantName: row.plant_name,
			areaName: row.area_name,
			vendorName: row.vendor_name,
			startAt: row.start_at ? new Date(row.start_at).toISOString() : null,
			endAt: row.end_at ? new Date(row.end_at).toISOString() : null,
			present: counts.present,
			total: counts.total,
			fraud: counts.fraud,
			problems: pumpProblems(counts, late),
			check: row.checked_at
				? { by: row.checked_by, at: new Date(row.checked_at).toISOString(), note: row.note }
				: null
		};
	});
	// To do first: fraud, then problems not yet checked, then checked ones, then pumps that are fine.
	const rank = (p: PumpCheck) => (p.fraud ? 0 : 1) + (p.problems.length ? (p.check ? 2 : 0) : 4);
	return pumps.sort(
		(a, b) =>
			rank(a) - rank(b) ||
			a.areaName.localeCompare(b.areaName) ||
			a.pumpCode.localeCompare(b.pumpCode)
	);
}

// Marks the pump checked for the day, replacing an earlier check. False when the manager cannot
// see the pump.
export async function savePumpCheck(managerId: string, pumpId: string, day: string, note: string) {
	const row = await queryOne(
		`INSERT INTO pump_day_checks (pump_id, session_date, checked_by_manager_id, note)
		 SELECT pu.id, $3, $1, NULLIF($4, '') FROM pumps pu
		 JOIN manager_plants mp ON mp.plant_id = pu.plant_id AND mp.manager_id = $1 WHERE pu.id = $2
		 ON CONFLICT (pump_id, session_date) DO UPDATE SET
		   checked_by_manager_id = EXCLUDED.checked_by_manager_id, checked_by_admin_id = NULL,
		   note = EXCLUDED.note, checked_at = now()
		 RETURNING pump_id`,
		[managerId, pumpId, day, note]
	);
	return Boolean(row);
}

export async function clearPumpCheck(managerId: string, pumpId: string, day: string) {
	await query(
		`DELETE FROM pump_day_checks pdc USING pumps pu, manager_plants mp
		 WHERE pdc.pump_id = $2 AND pdc.session_date = $3 AND pu.id = pdc.pump_id
		   AND mp.plant_id = pu.plant_id AND mp.manager_id = $1`,
		[managerId, pumpId, day]
	);
}
