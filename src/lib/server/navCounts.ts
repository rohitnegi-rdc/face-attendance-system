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

// Open cross-pump fraud cases touching the user's pumps, for the read-only lists (plant manager
// Approvals, vendor Fraud). Same scope as the badge count, so the badge and the list always agree.
// Confirming or clearing is the admin's call (/admin/fraud-flags).
export async function listOpenFraud(role: NavRole, userId: string) {
	return query<any>(
		`SELECT ff.id, ff.face_crop_url, ff.similarity_score, ff.is_operator,
		        to_char(ff.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI am') AS flagged_at,
		        pu.pump_code AS flagged_pump, fpl.name AS flagged_plant,
		        mp.pump_code AS matched_pump, mpl.name AS matched_plant
		 FROM fraud_flags ff
		 JOIN attendance_sessions s ON s.id = ff.session_id
		 JOIN pumps pu ON pu.id = s.pump_id JOIN plants fpl ON fpl.id = pu.plant_id
		 JOIN pumps mp ON mp.id = ff.matched_at_pump_id JOIN plants mpl ON mpl.id = mp.plant_id
		 WHERE NOT ff.reviewed AND (${pumpScope(role, 'pu')} OR ${pumpScope(role, 'mp')})
		 ORDER BY ff.created_at DESC
		 LIMIT 100`,
		role === 'admin' ? [] : [userId]
	);
}

export async function markSeen(role: NavRole, userId: string, section: string) {
	await query(
		`INSERT INTO nav_seen (role, user_id, section, seen_at) VALUES ($1, $2, $3, now())
		 ON CONFLICT (role, user_id, section) DO UPDATE SET seen_at = now()`,
		[role, userId, section]
	);
}

// Which badge the page being opened clears: Attendance, or the fraud list (admin Fraud flags,
// vendor Fraud, plant manager Approvals).
export type NavSection = 'attendance' | 'fraud';

// The section a path opens: the page itself or anything under it (an approval's detail page).
export function sectionForPath(
	pathname: string,
	paths: Record<NavSection, string>
): NavSection | null {
	for (const section of ['attendance', 'fraud'] as const) {
		const path = paths[section];
		if (pathname === path || pathname.startsWith(`${path}/`)) return section;
	}
	return null;
}

// When the user last opened that section ($1 = user id). A first visit ever counts the last day,
// not the whole history.
function seenSince(role: NavRole, section: NavSection) {
	return `COALESCE((SELECT seen_at FROM nav_seen
	                  WHERE role = '${role}' AND user_id = $1 AND section = '${section}'),
	                 now() - interval '24 hours')`;
}

// Every badge counts what is new since the user last opened its page, so opening the page
// clears it. The pages still list everything open: the badge is news, not a to-do count.
export async function loadNavCounts(
	role: NavRole,
	userId: string,
	openingSection: NavSection | null
): Promise<NavCounts> {
	// Marked before counting, so the page and the badge never race each other.
	if (openingSection) await markSeen(role, userId, openingSection);
	const params = [userId];
	const [attendance, fraud, location] = await Promise.all([
		queryOne<{ n: number }>(
			`SELECT count(*)::int AS n
			 FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
			 WHERE ${pumpScope(role, 'pu')} AND s.submitted_at > ${seenSince(role, 'attendance')}`,
			params
		),
		queryOne<{ n: number }>(
			`SELECT count(*)::int AS n
			 FROM fraud_flags ff
			 JOIN attendance_sessions s ON s.id = ff.session_id
			 JOIN pumps pu ON pu.id = s.pump_id
			 JOIN pumps mp ON mp.id = ff.matched_at_pump_id
			 WHERE NOT ff.reviewed AND (${pumpScope(role, 'pu')} OR ${pumpScope(role, 'mp')})
			   AND ff.created_at > ${seenSince(role, 'fraud')}`,
			params
		),
		role === 'plant-manager'
			? queryOne<{ n: number }>(
					`SELECT count(*)::int AS n
					 FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
					 WHERE s.location_status = 'pending' AND ${pumpScope(role, 'pu')}
					   AND s.submitted_at > ${seenSince(role, 'fraud')}`,
					params
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
