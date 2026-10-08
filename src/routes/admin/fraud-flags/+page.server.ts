import type { PageServerLoad, Actions } from './$types';
import { fail } from '@sveltejs/kit';
import { pool, query } from '$lib/server/db';
import { logger } from '$lib/server/log';
import { ResolutionError, confirmFraud, markNotFraud } from '$lib/server/fraudResolution';

export const load: PageServerLoad = async () => {
	const flags = await query<any>(
		`SELECT ff.id, ff.session_id, ff.person_id, ff.matched_at_pump_id, ff.matched_session_id,
		        ff.similarity_score, ff.reviewed, ff.created_at, ff.face_crop_url, ff.resolution,
		        ff.resolved_at, p.display_seq,
		        pu1.pump_code AS flagged_at_pump, pl1.name AS flagged_at_plant,
		        v1.name AS flagged_at_vendor, a1.name AS flagged_at_area,
		        pu2.pump_code AS matched_at_pump, pl2.name AS matched_at_plant,
		        v2.name AS matched_at_vendor, a2.name AS matched_at_area,
		        s.submitted_at AS flagged_submitted_at,
		        matched_session.submitted_at AS matched_submitted_at,
		        (s.photo_url IS NOT NULL) AS flagged_photo_available,
		        (matched_session.photo_url IS NOT NULL) AS matched_photo_available,
		        pfv.source_photo_crop_url, (ff.face_embedding IS NOT NULL) AS can_restore,
		        resolver.email AS resolved_by_email
		 FROM fraud_flags ff
		 JOIN persons p ON p.id = ff.person_id
		 JOIN attendance_sessions s ON s.id = ff.session_id
		 JOIN pumps pu1 ON pu1.id = s.pump_id
		 JOIN plants pl1 ON pl1.id = pu1.plant_id
		 JOIN vendors v1 ON v1.id = pu1.vendor_id
		 JOIN areas a1 ON a1.id = pl1.area_id
		 JOIN pumps pu2 ON pu2.id = ff.matched_at_pump_id
		 JOIN plants pl2 ON pl2.id = pu2.plant_id
		 JOIN vendors v2 ON v2.id = pu2.vendor_id
		 JOIN areas a2 ON a2.id = pl2.area_id
		 JOIN attendance_sessions matched_session ON matched_session.id = ff.matched_session_id
		 LEFT JOIN LATERAL (
		   SELECT source_photo_crop_url FROM person_face_vectors
		   WHERE person_id = p.id ORDER BY created_at DESC LIMIT 1
		 ) pfv ON true
		 LEFT JOIN admins resolver ON resolver.id = ff.resolved_by_admin_id
		 ORDER BY ff.reviewed ASC, ff.created_at DESC LIMIT 200`
	);
	return { flags };
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveFlag(
	request: Request,
	adminId: string,
	decision: 'confirmed_fraud' | 'not_fraud'
) {
	const flagId = String((await request.formData()).get('id') || '');
	if (!UUID_PATTERN.test(flagId)) return fail(400, { message: 'Invalid request.' });
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const outcome =
			decision === 'not_fraud'
				? await markNotFraud(client, flagId, adminId)
				: (await confirmFraud(client, flagId, adminId), null);
		await client.query(
			`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
			 VALUES ($1, $2, 'fraud_flag', $3, $4)`,
			[
				adminId,
				decision === 'not_fraud' ? 'fraud_flag_not_fraud' : 'fraud_flag_confirmed',
				flagId,
				JSON.stringify(outcome ?? {})
			]
		);
		await client.query('COMMIT');
		logger.warn({ adminId, flagId, decision, ...outcome }, 'fraud flag resolved');
		return {
			success: true,
			message:
				decision === 'not_fraud'
					? outcome?.createdPerson
						? 'Marked not fraud. A new worker was added at the flagged pump and marked present.'
						: 'Marked not fraud. The worker is marked present at the flagged pump.'
					: 'Confirmed as fraud. The worker stays absent at the flagged pump.'
		};
	} catch (resolveError) {
		await client.query('ROLLBACK').catch(() => {});
		if (resolveError instanceof ResolutionError) {
			return fail(400, { message: resolveError.message });
		}
		logger.error({ adminId, flagId, error: String(resolveError) }, 'fraud flag resolution failed');
		return fail(500, { message: 'Could not resolve the flag. Nothing was changed.' });
	} finally {
		client.release();
	}
}

export const actions: Actions = {
	// Kept as "review" so existing links/tests keep working; it now records "confirmed fraud".
	review: async ({ request, locals }) => resolveFlag(request, locals.user!.id, 'confirmed_fraud'),
	notFraud: async ({ request, locals }) => resolveFlag(request, locals.user!.id, 'not_fraud')
};
