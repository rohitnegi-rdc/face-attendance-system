// The 8 pm email to each monitor (migration 044): the pumps of their Areas that need a look today,
// with the same problems as the checklist on their Overview (pumpProblems in
// src/lib/server/pumpChecks.ts, copied here: the worker cannot import the app's code).
// One email per monitor per day: the monitor_digest_log row is claimed before sending, so two
// workers never both send it. No email when nothing needs a look.
import { sendMonitorDigestEmail } from './mailer.js';

export const DIGEST_HOUR_IST = 20;

// IST date and hour, computed in code (never the container time zone).
function istNow(date) {
	const ist = new Date(date.getTime() + 330 * 60_000);
	return { day: ist.toISOString().slice(0, 10), hour: ist.getUTCHours() };
}

// The same rules as pumpProblems in src/lib/server/pumpChecks.ts at 8 pm, when a missing end counts.
export function pumpProblems(row) {
	const problems = [];
	if (row.fraud) problems.push(`${row.fraud} fraud`);
	if (row.failed) problems.push('Photo failed');
	if (!row.start_at && !row.end_at) problems.push('No photo');
	else if (!row.start_at) problems.push('No start photo');
	else if (!row.end_at) problems.push('No end photo');
	const short = row.total - row.present;
	if (row.end_at && short > 0) problems.push(`${short} not a full shift`);
	return problems;
}

async function monitorPumps(db, managerId, day) {
	const { rows } = await db.query(
		`SELECT pu.pump_code, pl.name AS plant_name, a.name AS area_name,
		        EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.pump_id = pu.id AND s.session_date = $2
		          AND s.session_type = 'morning' AND s.status <> 'failed') AS start_at,
		        EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.pump_id = pu.id AND s.session_date = $2
		          AND s.session_type = 'evening' AND s.status <> 'failed') AS end_at,
		        (SELECT count(*)::int FROM attendance_sessions s WHERE s.pump_id = pu.id AND s.session_date = $2
		          AND s.status = 'failed' AND NOT EXISTS (SELECT 1 FROM attendance_sessions ok
		            WHERE ok.pump_id = pu.id AND ok.session_date = $2
		              AND ok.session_type = s.session_type AND ok.status <> 'failed')) AS failed,
		        (SELECT count(*)::int FILTER (WHERE morning_matched AND evening_matched)
		          FROM daily_person_attendance WHERE pump_id = pu.id AND session_date = $2) AS present,
		        (SELECT count(*)::int FROM daily_person_attendance
		          WHERE pump_id = pu.id AND session_date = $2) AS total,
		        (SELECT count(*)::int FROM fraud_flags ff JOIN attendance_sessions s ON s.id = ff.session_id
		          WHERE s.pump_id = pu.id AND s.session_date = $2) AS fraud
		 FROM manager_plants mp JOIN pumps pu ON pu.plant_id = mp.plant_id
		 JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		 WHERE mp.manager_id = $1
		 ORDER BY a.name, pu.pump_code`,
		[managerId, day]
	);
	return rows;
}

// Called every few minutes; does nothing before 8 pm IST or once today's emails are out. While
// the admin Test mode is on (`testModeOn`) the email is logged instead of sent, like fraud alerts.
export async function sendMonitorDigests(db, log, testModeOn, now = new Date()) {
	const { day, hour } = istNow(now);
	if (hour < DIGEST_HOUR_IST) return;
	const { rows: monitors } = await db.query(
		`SELECT pm.id, pm.name, pm.email FROM plant_managers pm
		 WHERE pm.is_monitor AND EXISTS (SELECT 1 FROM monitor_areas ma WHERE ma.manager_id = pm.id)
		   AND NOT EXISTS (SELECT 1 FROM monitor_digest_log l WHERE l.manager_id = pm.id AND l.day = $1)`,
		[day]
	);
	for (const monitor of monitors) {
		const claimed = await db.query(
			`INSERT INTO monitor_digest_log (manager_id, day) VALUES ($1, $2)
			 ON CONFLICT DO NOTHING RETURNING manager_id`,
			[monitor.id, day]
		);
		if (!claimed.rowCount) continue;
		const pumps = (await monitorPumps(db, monitor.id, day))
			.map((row) => ({ ...row, problems: pumpProblems(row) }))
			.filter((row) => row.problems.length);
		if (!pumps.length) {
			log('info', { managerId: monitor.id, day }, 'monitor digest: nothing to report');
			continue;
		}
		if (await testModeOn(db)) {
			log(
				'info',
				{ managerId: monitor.id, day, pumps: pumps.length },
				'monitor digest email NOT sent (test mode)'
			);
			continue;
		}
		await sendMonitorDigestEmail({ to: monitor.email, name: monitor.name, day, pumps }, log);
	}
}
