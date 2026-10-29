import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { pool, query } from '$lib/server/db';
import { faceMatchThreshold } from '$lib/server/matching';
import { mergeWorkers } from '$lib/server/faceFixes';

const LOWER_BOUND = 0.2;
const UPPER_BOUND = faceMatchThreshold();

export const load: PageServerLoad = async () => {
	const candidates = await query<any>(
		`SELECT DISTINCT ON (LEAST(p1.id, p2.id), GREATEST(p1.id, p2.id))
		        p1.id AS person_a, p2.id AS person_b, p1.pump_id,
		        p1.display_seq AS display_seq_a, p2.display_seq AS display_seq_b, p1.name AS name_a, p2.name AS name_b,
		        p1.first_seen_at AS first_seen_a, p2.first_seen_at AS first_seen_b,
		        p1.last_seen_at AS last_seen_a, p2.last_seen_at AS last_seen_b,
		        pu.pump_code,
		        v1.source_photo_crop_url AS crop_a, v2.source_photo_crop_url AS crop_b,
		        1 - (v1.embedding <=> v2.embedding) AS similarity,
		        (SELECT COUNT(*) FROM daily_person_attendance d WHERE d.person_id = p1.id) AS days_a,
		        (SELECT COUNT(*) FROM daily_person_attendance d WHERE d.person_id = p2.id) AS days_b
		 FROM persons p1
		 JOIN persons p2 ON p2.pump_id = p1.pump_id AND p2.id > p1.id AND p2.status = 'active'
		 JOIN pumps pu ON pu.id = p1.pump_id
		 JOIN person_face_vectors v1 ON v1.person_id = p1.id
		 JOIN person_face_vectors v2 ON v2.person_id = p2.id
		 LEFT JOIN merge_review_decisions decision
		   ON decision.lower_person_id = LEAST(p1.id, p2.id)
		  AND decision.higher_person_id = GREATEST(p1.id, p2.id)
		 WHERE p1.status = 'active' AND decision.id IS NULL
		 ORDER BY LEAST(p1.id, p2.id), GREATEST(p1.id, p2.id), similarity DESC`
	);
	return {
		candidates: candidates.filter(
			(candidate: any) => candidate.similarity >= LOWER_BOUND && candidate.similarity < UPPER_BOUND
		)
	};
};

export const actions: Actions = {
	confirm: async ({ request, locals }) => {
		const form = await request.formData();
		const keptId = String(form.get('kept') || '');
		const mergedId = String(form.get('merged') || '');
		const similarity = Number(form.get('similarity'));
		if (!keptId || !mergedId || keptId === mergedId)
			return fail(400, { message: 'Invalid merge pair.' });

		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await mergeWorkers(client, {
				keptId,
				mergedId,
				actor: { role: 'admin', id: locals.user!.id },
				similarity
			});
			await client.query('COMMIT');
			return { success: true, message: 'People merged.' };
		} catch (error) {
			await client.query('ROLLBACK');
			return fail(400, { message: error instanceof Error ? error.message : 'Merge failed.' });
		} finally {
			client.release();
		}
	},
	dismiss: async ({ request, locals }) => {
		const form = await request.formData();
		const personA = String(form.get('person_a') || '');
		const personB = String(form.get('person_b') || '');
		const similarity = Number(form.get('similarity'));
		if (!personA || !personB || personA === personB)
			return fail(400, { message: 'Invalid merge pair.' });

		const client = await pool.connect();
		try {
			await recordDecision(client, personA, personB, 'dismissed', locals.user!.id, similarity);
			return { success: true, message: 'Suggestion dismissed.' };
		} finally {
			client.release();
		}
	}
};

async function recordDecision(
	client: import('pg').PoolClient,
	personA: string,
	personB: string,
	decision: 'dismissed' | 'merged',
	adminId: string,
	similarity: number
) {
	const [lower, higher] = [personA, personB].sort();
	await client.query(
		`INSERT INTO merge_review_decisions
		   (lower_person_id, higher_person_id, decision, reviewed_by_admin_id, similarity_score)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (lower_person_id, higher_person_id) DO UPDATE SET
		   decision = EXCLUDED.decision,
		   reviewed_by_admin_id = EXCLUDED.reviewed_by_admin_id,
		   similarity_score = EXCLUDED.similarity_score,
		   reviewed_at = now()`,
		[lower, higher, decision, adminId, similarity]
	);
}
