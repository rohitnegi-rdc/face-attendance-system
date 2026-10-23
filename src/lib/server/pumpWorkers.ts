import { query } from '$lib/server/db';
import { personShortLabel } from '$lib/personLabel';

// The workers an admin face fix can go to (WorkerPicker.svelte): active and new workers of each
// pump, each with their latest face, minus the workers already counted in the photo being fixed
// (one face per worker per photo, faceFixes.ts).
export async function pumpWorkers(pumpIds: string[], sessionIds: string[]) {
	const pumps = [...new Set(pumpIds)];
	const sessions = [...new Set(sessionIds)];
	const [workers, counted] = pumps.length
		? await Promise.all([
				query<any>(
					`SELECT p.id, p.pump_id, p.display_seq, p.name, p.is_operator,
					        (SELECT source_photo_crop_url FROM person_face_vectors
					         WHERE person_id = p.id AND source_photo_crop_url IS NOT NULL
					         ORDER BY in_gallery DESC, created_at DESC LIMIT 1) AS preview_url
					 FROM persons p
					 WHERE p.pump_id = ANY($1::uuid[]) AND p.status IN ('active', 'pending_review')
					 ORDER BY p.display_seq`,
					[pumps]
				),
				sessions.length
					? query<any>(
							`SELECT session_id, person_id FROM attendance_face_evidence
							 WHERE session_id = ANY($1::uuid[])`,
							[sessions]
						)
					: Promise.resolve([])
			])
		: [[], []];

	return {
		forSession(pumpId: string, sessionId: string | null, excludePersonId?: string) {
			const inPhoto = new Set(
				counted.filter((row) => row.session_id === sessionId).map((row) => row.person_id)
			);
			return workers
				.filter(
					(worker) =>
						worker.pump_id === pumpId && !inPhoto.has(worker.id) && worker.id !== excludePersonId
				)
				.map((worker) => ({
					id: worker.id as string,
					label: personShortLabel(worker.display_seq, worker.is_operator, worker.name),
					previewUrl: worker.preview_url as string | null
				}));
		}
	};
}
