import type { PageServerLoad, Actions } from './$types';
import { query, queryOne } from '$lib/server/db';

const LOWER_BOUND = 0.55;
const UPPER_BOUND = Number(process.env.FACE_MATCH_THRESHOLD ?? 0.68);

export const load: PageServerLoad = async () => {
	// Compute on-the-fly: per-pump pairs of active persons in the "maybe same person" band.
	const candidates = await query<any>(
		`SELECT DISTINCT ON (LEAST(p1.id, p2.id), GREATEST(p1.id, p2.id))
		        p1.id AS person_a, p2.id AS person_b, p1.pump_id,
		        1 - (v1.embedding <=> v2.embedding) AS similarity
		 FROM persons p1
		 JOIN persons p2 ON p2.pump_id = p1.pump_id AND p2.id > p1.id AND p2.status = 'active'
		 JOIN person_face_vectors v1 ON v1.person_id = p1.id
		 JOIN person_face_vectors v2 ON v2.person_id = p2.id
		 WHERE p1.status = 'active'
		 ORDER BY LEAST(p1.id, p2.id), GREATEST(p1.id, p2.id), similarity DESC`
	);
	const filtered = candidates.filter((c: any) => c.similarity >= LOWER_BOUND && c.similarity < UPPER_BOUND);
	return { candidates: filtered };
};

export const actions: Actions = {
	confirm: async ({ request, locals }) => {
		const form = await request.formData();
		const keptId = form.get('kept') as string;
		const mergedId = form.get('merged') as string;
		const similarity = Number(form.get('similarity'));

		await query('UPDATE daily_person_attendance SET person_id = $1 WHERE person_id = $2', [keptId, mergedId]);
		await query('UPDATE person_face_vectors SET person_id = $1 WHERE person_id = $2', [keptId, mergedId]);
		await query(`UPDATE persons SET status = 'merged', merged_into_person_id = $1 WHERE id = $2`, [
			keptId,
			mergedId
		]);
		await query(
			'INSERT INTO person_merge_log (kept_person_id, merged_person_id, admin_id, similarity_score) VALUES ($1, $2, $3, $4)',
			[keptId, mergedId, locals.user!.id, similarity]
		);
	}
	// dismiss: computed on-the-fly candidates re-evaluate each load; a persistent "dismissed" flag
	// would need a merge_candidates table — acceptable prototype simplification, noted in
	// plans/ImplementationSummary.md.
};
