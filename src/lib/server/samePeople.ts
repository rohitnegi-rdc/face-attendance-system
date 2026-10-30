// "Same people?" on Fix attendance (admin and plant manager). When the camera did not match the
// same crew between a shift's start and end photos, the start shows workers missing at the end
// and the end shows new ones. This lists both sides, suggests pairs (closest face, same name
// first), and merges the pairs the user confirms (mergeWorkers), so the day counts as a full
// shift and the faces join one gallery for next time.
import type { PoolClient } from 'pg';
import { resolve } from '$app/paths';
import { personShortLabel } from '$lib/personLabel';
import { FaceFixError, mergeWorkers, type FixActor } from './faceFixes';

type Db = Pick<PoolClient, 'query'>;

export type SameWorker = { id: string; label: string; faceUrl: string | null };
export type SamePeople = {
	startOnly: SameWorker[];
	endOnly: SameWorker[];
	// End worker id -> suggested start worker id (one question per new face at the end).
	suggested: Record<string, string>;
};

// Below this a pair is not suggested on looks alone; the user can still pick it.
const SUGGEST_FROM = 0.15;

async function shiftSplit(db: Db, pumpId: string, day: string) {
	// A merged worker's old faces show as the worker they were merged into.
	const { rows: faces } = await db.query(
		`SELECT s.session_type, afe.id AS evidence_id, afe.face_crop_url IS NOT NULL AS has_crop,
		        shown.id AS person_id, shown.display_seq, shown.name, shown.is_operator
		 FROM attendance_sessions s
		 JOIN attendance_face_evidence afe ON afe.session_id = s.id
		 JOIN persons p ON p.id = afe.person_id
		 JOIN persons shown ON shown.id = CASE WHEN p.status = 'merged'
		   THEN COALESCE(p.merged_into_person_id, p.id) ELSE p.id END
		 WHERE s.pump_id = $1 AND s.session_date = $2 AND s.status = 'completed'
		   AND shown.status IN ('active', 'pending_review')
		 ORDER BY shown.is_operator DESC, shown.display_seq`,
		[pumpId, day]
	);
	const side = (type: string) => {
		const workers = new Map<string, SameWorker & { name: string | null }>();
		for (const face of faces.filter((f) => f.session_type === type)) {
			if (workers.has(face.person_id)) continue;
			workers.set(face.person_id, {
				id: face.person_id,
				name: face.name,
				label: personShortLabel(face.display_seq, face.is_operator, face.name),
				faceUrl: face.has_crop
					? resolve('/api/attendance/face/[id]', { id: face.evidence_id })
					: null
			});
		}
		return workers;
	};
	const start = side('morning');
	const end = side('evening');
	const startOnly = [...start.values()].filter((w) => !end.has(w.id));
	const endOnly = [...end.values()].filter((w) => !start.has(w.id));
	if (!start.size || !end.size || !startOnly.length || !endOnly.length) return null;

	const { rows: scores } = await db.query(
		`SELECT a.person_id AS start_id, b.person_id AS end_id,
		        MAX(1 - (a.embedding <=> b.embedding)) AS similarity
		 FROM person_face_vectors a, person_face_vectors b
		 WHERE a.person_id = ANY($1::uuid[]) AND b.person_id = ANY($2::uuid[])
		 GROUP BY a.person_id, b.person_id`,
		[startOnly.map((w) => w.id), endOnly.map((w) => w.id)]
	);
	const similarity = new Map<string, number>(
		scores.map((row) => [`${row.start_id}|${row.end_id}`, Number(row.similarity)])
	);
	// Strongest first, one end worker per start worker: the same name counts above any face score.
	const options = startOnly.flatMap((s) =>
		endOnly.map((e) => {
			const looks = similarity.get(`${s.id}|${e.id}`) ?? -1;
			const sameName = Boolean(s.name && e.name && s.name.toLowerCase() === e.name.toLowerCase());
			return { start: s.id, end: e.id, looks, sameName, score: looks + (sameName ? 1 : 0) };
		})
	);
	options.sort((a, b) => b.score - a.score);
	const suggested: Record<string, string> = {};
	const taken = new Set<string>();
	for (const option of options) {
		if (suggested[option.end] || taken.has(option.start)) continue;
		if (!option.sameName && option.looks < SUGGEST_FROM) continue;
		suggested[option.end] = option.start;
		taken.add(option.start);
	}
	const strip = ({ id, label, faceUrl }: SameWorker) => ({ id, label, faceUrl });
	return {
		same: { startOnly: startOnly.map(strip), endOnly: endOnly.map(strip), suggested },
		similarity
	};
}

// The split of one pump's shift, or null when its start and end show the same workers.
export async function findSamePeople(db: Db, pumpId: string, day: string) {
	return (await shiftSplit(db, pumpId, day))?.same ?? null;
}

// Merges the pairs picked on the form (field pair_<end worker id> = start worker id, or empty
// for "someone new"). Runs in the caller's transaction; audited with the pairs.
export async function mergeSamePeople(
	client: PoolClient,
	input: { pumpId: string; day: string; form: FormData; actor: FixActor }
) {
	const { pumpId, day, form, actor } = input;
	if (actor.role === 'plant-manager') {
		const { rowCount } = await client.query(
			`SELECT 1 FROM pumps pu JOIN manager_plants pma ON pma.plant_id = pu.plant_id
			 WHERE pu.id = $1 AND pma.manager_id = $2`,
			[pumpId, actor.id]
		);
		if (!rowCount) throw new FaceFixError('Pump not found.');
	}
	const split = await shiftSplit(client, pumpId, day);
	if (!split) throw new FaceFixError('These workers were already merged. Reload the page.');
	const startIds = new Set(split.same.startOnly.map((w) => w.id));
	const pairs: { keptId: string; mergedId: string }[] = [];
	const used = new Set<string>();
	for (const worker of split.same.endOnly) {
		const startId = String(form.get(`pair_${worker.id}`) ?? '');
		if (!startId) continue;
		if (!startIds.has(startId) || used.has(startId)) {
			throw new FaceFixError('Each person from the shift start can be picked once. Check again.');
		}
		used.add(startId);
		pairs.push({ keptId: startId, mergedId: worker.id });
	}
	if (!pairs.length)
		throw new FaceFixError('Tap who each new face is, or leave them as Someone new.');

	for (const pair of pairs) {
		await mergeWorkers(client, {
			...pair,
			actor,
			similarity: split.similarity.get(`${pair.keptId}|${pair.mergedId}`) ?? null
		});
	}
	await client.query(
		`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
		 VALUES ($1, 'merge_same_people', 'pump', $2, $3)`,
		[actor.role === 'admin' ? actor.id : null, pumpId, JSON.stringify({ day, pairs, by: actor })]
	);
	return pairs.length;
}

export function mergedMessage(count: number) {
	return `Saved. ${count} ${count === 1 ? 'person now counts' : 'people now count'} for the full shift, and the camera will know them next time.`;
}
