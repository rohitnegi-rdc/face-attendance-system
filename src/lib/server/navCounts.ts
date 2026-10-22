// Counts on the side navigation (AppShell): new shift photos since the user last opened their
// Attendance page, and cross-pump fraud flags still waiting for an admin. Each role sees only its
// own pumps; a fraud flag counts when either pump of the pair is in scope.
import { query, queryOne } from './db';

export type NavRole = 'admin' | 'vendor' | 'plant-manager';
export type NavCounts = { attendance: number; fraud: number; approvals: number };

// SQL condition putting a pump alias in the user's scope ($1 = user id).
function pumpScope(role: NavRole, alias: string) {
	if (role === 'vendor') return `${alias}.vendor_id = $1`;
	if (role === 'plant-manager')
		return `${alias}.plant_id IN (SELECT plant_id FROM plant_manager_assignments WHERE manager_id = $1)`;
	return 'TRUE';
}

export async function markSeen(role: NavRole, userId: string, section: string) {
	await query(
		`INSERT INTO nav_seen (role, user_id, section, seen_at) VALUES ($1, $2, $3, now())
		 ON CONFLICT (role, user_id, section) DO UPDATE SET seen_at = now()`,
		[role, userId, section]
	);
}

export async function loadNavCounts(
	role: NavRole,
	userId: string,
	onAttendancePage: boolean
): Promise<NavCounts> {
	// Opening the Attendance page clears its count. Done here, before counting, so the page and
	// the badge never race each other.
	if (onAttendancePage) await markSeen(role, userId, 'attendance');
	const scopeParams = role === 'admin' ? [] : [userId];
	const seenParam = `$${scopeParams.length + 1}`;
	const [attendance, fraud, location] = await Promise.all([
		onAttendancePage
			? Promise.resolve({ n: 0 })
			: // A first visit ever counts the last day, not the whole history.
				queryOne<{ n: number }>(
					`SELECT count(*)::int AS n
					 FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
					 WHERE ${pumpScope(role, 'pu')}
					   AND s.submitted_at > COALESCE(
					     (SELECT seen_at FROM nav_seen
					      WHERE role = '${role}' AND user_id = ${seenParam} AND section = 'attendance'),
					     now() - interval '24 hours')`,
					[...scopeParams, userId]
				),
		queryOne<{ n: number }>(
			`SELECT count(*)::int AS n
			 FROM fraud_flags ff
			 JOIN attendance_sessions s ON s.id = ff.session_id
			 JOIN pumps pu ON pu.id = s.pump_id
			 JOIN pumps mp ON mp.id = ff.matched_at_pump_id
			 WHERE NOT ff.reviewed AND (${pumpScope(role, 'pu')} OR ${pumpScope(role, 'mp')})`,
			scopeParams
		),
		role === 'plant-manager'
			? queryOne<{ n: number }>(
					`SELECT count(*)::int AS n
					 FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
					 WHERE s.location_status = 'pending' AND ${pumpScope(role, 'pu')}`,
					scopeParams
				)
			: Promise.resolve({ n: 0 })
	]);
	const fraudCount = fraud?.n ?? 0;
	return {
		attendance: attendance?.n ?? 0,
		fraud: fraudCount,
		// The plant manager's Approvals page lists both: locations to decide and fraud to watch.
		approvals: (location?.n ?? 0) + fraudCount
	};
}
