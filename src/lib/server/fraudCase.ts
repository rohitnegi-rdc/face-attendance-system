// One cross-pump fraud case, both sightings side by side, for the read-only detail pages
// (plant manager /plant-manager/approvals/fraud/[id], vendor /vendor/fraud/[id]). Scoped like the
// list and the badge (pumpScope): visible only when either pump of the pair is the user's.
import { error } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { queryOne } from './db';
import { pumpScope, type NavRole } from './navCounts';
import { personShortLabel } from '$lib/personLabel';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Dates and times in IST, computed in SQL from timestamptz (never the server's zone).
const DAY = `'Dy, DD Mon YYYY'`;
const TIME = `'HH12:MI am'`;

function sighting(prefix: 's' | 'm') {
	return `${prefix}.id AS ${prefix}_session_id, ${prefix}.session_type AS ${prefix}_session_type,
	        to_char(${prefix}.session_date, ${DAY}) AS ${prefix}_shift_date,
	        to_char(${prefix}.submitted_at AT TIME ZONE 'Asia/Kolkata', ${DAY}) AS ${prefix}_sent_date,
	        to_char(${prefix}.submitted_at AT TIME ZONE 'Asia/Kolkata', ${TIME}) AS ${prefix}_sent_time,
	        (${prefix}.photo_url IS NOT NULL) AS ${prefix}_has_photo`;
}

// Plant managers may open group photos of their own plants only (the photo route checks this too).
function photoAllowed(role: NavRole, alias: string) {
	return role === 'plant-manager'
		? `${alias}.plant_id IN (SELECT plant_id FROM plant_manager_assignments WHERE manager_id = $2)`
		: 'FALSE';
}

export async function loadFraudCase(role: NavRole, userId: string, flagId: string) {
	if (!UUID_PATTERN.test(flagId)) error(404, 'Fraud case not found');
	// $1 is the flag here, so the user id moves to $2 in the shared scope condition.
	const scope = (alias: string) => pumpScope(role, alias).replaceAll('$1', '$2');
	const row = await queryOne<any>(
		`SELECT ff.id, ff.similarity_score, ff.is_operator, ff.reviewed, ff.resolution,
		        ff.face_crop_url AS flagged_face,
		        to_char(ff.created_at AT TIME ZONE 'Asia/Kolkata', ${DAY}) AS found_date,
		        to_char(ff.created_at AT TIME ZONE 'Asia/Kolkata', ${TIME}) AS found_time,
		        to_char(ff.resolved_at AT TIME ZONE 'Asia/Kolkata', ${DAY}) AS resolved_date,
		        ROUND(EXTRACT(EPOCH FROM (s.submitted_at - m.submitted_at)) / 60)::int AS gap_minutes,
		        ${sighting('s')}, ${sighting('m')},
		        pu.pump_code AS s_pump, pl.name AS s_plant, a.name AS s_area, v.name AS s_vendor,
		        mp.pump_code AS m_pump, mpl.name AS m_plant, ma.name AS m_area, mv.name AS m_vendor,
		        p.display_seq AS m_display_seq, p.is_operator AS m_is_operator, p.name AS m_name,
		        COALESCE(afe.face_crop_url, pfv.source_photo_crop_url) AS matched_face,
		        ${photoAllowed(role, 'pu')} AS s_photo_allowed,
		        ${photoAllowed(role, 'mp')} AS m_photo_allowed
		 FROM fraud_flags ff
		 JOIN attendance_sessions s ON s.id = ff.session_id
		 JOIN pumps pu ON pu.id = s.pump_id JOIN plants pl ON pl.id = pu.plant_id
		 JOIN areas a ON a.id = pl.area_id JOIN vendors v ON v.id = pu.vendor_id
		 JOIN attendance_sessions m ON m.id = ff.matched_session_id
		 JOIN pumps mp ON mp.id = ff.matched_at_pump_id JOIN plants mpl ON mpl.id = mp.plant_id
		 JOIN areas ma ON ma.id = mpl.area_id JOIN vendors mv ON mv.id = mp.vendor_id
		 JOIN persons p ON p.id = ff.person_id
		 LEFT JOIN attendance_face_evidence afe
		   ON afe.session_id = ff.matched_session_id AND afe.person_id = ff.person_id
		 LEFT JOIN LATERAL (
		   SELECT source_photo_crop_url FROM person_face_vectors
		   WHERE person_id = ff.person_id ORDER BY created_at DESC LIMIT 1
		 ) pfv ON true
		 WHERE ff.id = $1 AND (${scope('pu')} OR ${scope('mp')})`,
		role === 'admin' ? [flagId] : [flagId, userId]
	);
	// Not found and not yours look the same, so ids cannot be probed.
	if (!row) error(404, 'Fraud case not found');

	const side = (prefix: 's' | 'm') => ({
		pump: row[`${prefix}_pump`] as string,
		plant: row[`${prefix}_plant`] as string,
		area: row[`${prefix}_area`] as string,
		vendor: row[`${prefix}_vendor`] as string,
		sessionType: row[`${prefix}_session_type`] as 'morning' | 'evening',
		shiftDate: row[`${prefix}_shift_date`] as string,
		sentDate: row[`${prefix}_sent_date`] as string,
		sentTime: row[`${prefix}_sent_time`] as string,
		groupPhotoUrl:
			row[`${prefix}_has_photo`] && row[`${prefix}_photo_allowed`]
				? resolve('/api/attendance/photo/[id]', { id: row[`${prefix}_session_id`] })
				: null
	});

	return {
		id: row.id as string,
		similarity: Number(row.similarity_score),
		state: (row.resolution === 'not_fraud' ? 'cleared' : row.reviewed ? 'confirmed' : 'open') as
			'open' | 'confirmed' | 'cleared',
		foundDate: row.found_date as string,
		foundTime: row.found_time as string,
		resolvedDate: row.resolved_date as string | null,
		// Minutes from the first sighting to the refused one (negative: the refused photo was older).
		gapMinutes: Number(row.gap_minutes),
		first: {
			...side('m'),
			face: row.matched_face as string | null,
			countedAs: personShortLabel(row.m_display_seq, row.m_is_operator, row.m_name)
		},
		refused: {
			...side('s'),
			face: row.flagged_face as string | null,
			fromOperatorPhoto: Boolean(row.is_operator)
		}
	};
}

export type FraudCase = Awaited<ReturnType<typeof loadFraudCase>>;
