import type { PageServerLoad } from './$types';
import { query } from '$lib/server/db';

export const load: PageServerLoad = async ({ locals, url }) => {
	const vendorId = locals.user!.id;
	const pump = url.searchParams.get('pump') || '';
	const [pumps, persons] = await Promise.all([
		query<any>('SELECT id, pump_code FROM pumps WHERE vendor_id = $1 ORDER BY pump_code', [
			vendorId
		]),
		query<any>(
			`SELECT p.id, p.display_seq, p.first_seen_at, p.last_seen_at, pu.pump_code,
			        pfv.source_photo_crop_url,
			        COUNT(dpa.id) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched) AS days_present,
			        COUNT(dpa.id) FILTER (WHERE dpa.morning_matched AND NOT dpa.evening_matched) AS days_morning_only,
			        COUNT(dpa.id) FILTER (WHERE NOT dpa.morning_matched AND dpa.evening_matched) AS days_evening_only
			 FROM persons p JOIN pumps pu ON pu.id = p.pump_id
			 LEFT JOIN daily_person_attendance dpa ON dpa.person_id = p.id
			 LEFT JOIN LATERAL (
			   SELECT source_photo_crop_url FROM person_face_vectors
			   WHERE person_id = p.id ORDER BY created_at DESC LIMIT 1
			 ) pfv ON true
			 WHERE pu.vendor_id = $1 AND p.status = 'active' AND ($2 = '' OR pu.id = $2::uuid)
			 GROUP BY p.id, pu.pump_code, pfv.source_photo_crop_url
			 ORDER BY p.last_seen_at DESC`,
			[vendorId, pump]
		)
	]);
	return { pumps, persons, pump };
};
