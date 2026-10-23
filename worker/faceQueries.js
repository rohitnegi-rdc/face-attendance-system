// The two face lookups the worker runs for every detected face, and the gallery rules for saving
// faces (also used by the app: fraudResolution.ts, attendanceReview.ts, flagged guests). Kept
// apart from index.js so the unit tests (tests/unit/faceQueries.test.ts) can run them against a
// real pgvector database.

/** @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} Queryable */

// CROSS-PUMP CHECK — Area-scoped, symmetric for every vendor account (§2).
// New workers (pending_review) and sessions still awaiting the pump's review count too. Comparing
// only against active people in completed sessions let the same new worker attend two pumps on
// day one, and made detection depend on which pump finished its review first (order-dependent,
// which §2 forbids).
// Only faces from that pump's own sessions of this shift date are compared, never the older
// gallery faces: an old, worse photo of a worker let a stranger match it, and the flag then
// pointed at a session that did not hold the matching face.
// Returns the best match ({ person_id, pump_id, similarity, session_date, matched_session_id })
// or undefined; the caller compares similarity with the threshold.
/**
 * @param {Queryable} client
 * @param {{ vector: string, sessionDate: string | Date, areaId: string, pumpId: string }} args
 */
export async function findCrossPumpMatch(client, { vector, sessionDate, areaId, pumpId }) {
	const { rows } = await client.query(
		`SELECT pfv.person_id, p.pump_id, 1 - (pfv.embedding <=> $1::vector) AS similarity,
		        dpa.session_date, ats.id AS matched_session_id
		 FROM person_face_vectors pfv
		 JOIN persons p ON p.id = pfv.person_id
		 JOIN daily_person_attendance dpa ON dpa.person_id = p.id AND dpa.session_date = $2
		 JOIN attendance_sessions ats ON ats.id = pfv.session_id
		   AND ats.pump_id = p.pump_id AND ats.session_date = $2
		 JOIN pumps pu2 ON pu2.id = p.pump_id
		 JOIN plants pl2 ON pl2.id = pu2.plant_id
		 WHERE pl2.area_id = $3 AND p.pump_id != $4
		   AND p.status IN ('active', 'pending_review')
		   AND ats.status IN ('completed', 'review')
		 ORDER BY similarity DESC LIMIT 1`,
		[vector, sessionDate, areaId, pumpId]
	);
	return rows[0];
}

// LOCAL MATCH — best similarity across this pump's own person gallery, new workers
// (pending_review) included, the same people the cross-pump check sees. Matching only active
// people made a new worker a second new person whenever the pump had not pressed Complete on
// the photo that first found them (a shift end, since the next day's start does not wait for it).
// Only gallery faces (in_gallery) are compared; see GALLERY below.
// findLocalCandidates returns the closest `limit` people, best first, as { person_id, similarity }.
/**
 * @param {Queryable} client
 * @param {{ vector: string, pumpId: string, limit: number }} args
 * @returns {Promise<{ person_id: string, similarity: number }[]>}
 */
export async function findLocalCandidates(client, { vector, pumpId, limit }) {
	const { rows } = await client.query(
		`SELECT pfv.person_id, MAX(1 - (pfv.embedding <=> $1::vector)) AS similarity
		 FROM person_face_vectors pfv
		 JOIN persons p ON p.id = pfv.person_id
		 WHERE p.pump_id = $2 AND p.status IN ('active', 'pending_review') AND pfv.in_gallery
		 GROUP BY pfv.person_id
		 ORDER BY similarity DESC LIMIT $3`,
		[vector, pumpId, limit]
	);
	return rows;
}

// One face on its own (admin "Not fraud"): { person_id, similarity, runner_up_similarity } or
// undefined; runner_up_similarity is the next-closest other person (null when there is none).
/**
 * @param {Queryable} client
 * @param {{ vector: string, pumpId: string }} args
 */
export async function findLocalMatch(client, { vector, pumpId }) {
	const [best, next] = await findLocalCandidates(client, { vector, pumpId, limit: 2 });
	if (!best) return undefined;
	return { ...best, runner_up_similarity: next?.similarity ?? null };
}

// ONE FACE PER PERSON — two faces in one photo are two people. Each face used to take its own
// best match, so two faces could both take the same worker and the second was folded into the
// first: one worker went missing and the photo still looked clean. Workers are now handed out
// strongest match first, each to one face only; a face whose best worker is taken falls back to
// its next-best one above the threshold, else it becomes a new worker (null here). The order
// faces come from the AI does not matter. A face that lost its best worker reports that worker's
// score as its runner-up, so keepsInGallery keeps it out of the gallery.
/**
 * @param {{ person_id: string, similarity: number }[][]} candidates per face, best first
 * @param {number} threshold
 * @returns {({ person_id: string, similarity: number, runner_up_similarity: number | null } | null)[]}
 */
export function assignFaces(candidates, threshold) {
	const pairs = candidates.flatMap((list, face) =>
		list.map((match, rank) => ({ ...match, face, rank })).filter((p) => p.similarity >= threshold)
	);
	pairs.sort((a, b) => b.similarity - a.similarity);
	/** @type {({ person_id: string, similarity: number, runner_up_similarity: number | null } | null)[]} */
	const assigned = candidates.map(() => null);
	const taken = new Set();
	for (const pair of pairs) {
		if (assigned[pair.face] || taken.has(pair.person_id)) continue;
		taken.add(pair.person_id);
		const list = candidates[pair.face];
		assigned[pair.face] = {
			person_id: pair.person_id,
			similarity: pair.similarity,
			runner_up_similarity: pair.rank === 0 ? (list[1]?.similarity ?? null) : list[0].similarity
		};
	}
	return assigned;
}

// GALLERY — the faces that teach the matcher who a person is (up to GALLERY_SIZE per person).
// Saving every matched face let a wrong match feed on itself: the wrong face joined the person's
// gallery, so the same wrong face matched them more easily the next day. Now a matched face joins
// the gallery only when the match is clear (keepsInGallery); otherwise it still counts attendance
// and keeps its row for the photo's own screens and the cross-pump check, with in_gallery false.
// The face a person was created from is the anchor and is never trimmed away.
export const GALLERY_SIZE = 5;
// Rows kept out of the gallery are only needed while their shift can still be compared or
// reviewed; older ones are removed when the person is next seen.
const NON_GALLERY_KEEP = '3 days';

// Defaults from the golden small-group run (2026-08-11, match-pairs.csv): different people never
// scored above 0.24, 88% of same-person faces scored 0.40 or more, and every correct match beat
// the next-closest person by at least 0.15. Env: GALLERY_ADD_THRESHOLD, GALLERY_ADD_MARGIN.
// The bar is never below the match threshold.
/** @param {number} matchThreshold */
export function galleryRules(matchThreshold) {
	const add = Number(process.env.GALLERY_ADD_THRESHOLD?.trim() || NaN);
	const margin = Number(process.env.GALLERY_ADD_MARGIN?.trim() || NaN);
	return {
		addThreshold: Math.max(add > 0 && add < 1 ? add : 0.4, matchThreshold),
		margin: margin >= 0 && margin < 1 ? margin : 0.1
	};
}

/**
 * @param {{ similarity: number, runner_up_similarity?: number | null }} match
 * @param {{ addThreshold: number, margin: number }} rules
 */
export function keepsInGallery(match, { addThreshold, margin }) {
	if (match.similarity < addThreshold) return false;
	const runnerUp = match.runner_up_similarity;
	return runnerUp == null || match.similarity - runnerUp >= margin;
}

// Saves one face for a person, then trims: gallery faces beyond GALLERY_SIZE go oldest first,
// anchors last; faces outside the gallery go once older than NON_GALLERY_KEEP.
/**
 * @param {Queryable} client
 * @param {{ personId: string, sessionId: string | null, vector: string, cropUrl: string | null,
 *   inGallery: boolean, isAnchor?: boolean }} face
 */
export async function saveFace(
	client,
	{ personId, sessionId, vector, cropUrl, inGallery, isAnchor = false }
) {
	await client.query(
		`INSERT INTO person_face_vectors
		   (person_id, session_id, embedding, source_photo_crop_url, in_gallery, is_anchor)
		 VALUES ($1, $2, $3::vector, $4, $5, $6)`,
		[personId, sessionId, vector, cropUrl, inGallery, isAnchor]
	);
	await trimGallery(client, personId);
}

// The trim saveFace applies; also after an admin moves faces onto a person (faceFixes.ts).
/**
 * @param {Queryable} client
 * @param {string} personId
 */
export async function trimGallery(client, personId) {
	await client.query(
		`DELETE FROM person_face_vectors WHERE id IN (
		   (SELECT id FROM person_face_vectors WHERE person_id = $1 AND in_gallery
		    ORDER BY is_anchor DESC, created_at DESC OFFSET $2)
		   UNION ALL
		   (SELECT id FROM person_face_vectors WHERE person_id = $1 AND NOT in_gallery
		      AND created_at < now() - $3::interval)
		 )`,
		[personId, GALLERY_SIZE, NON_GALLERY_KEEP]
	);
}

// An admin flagged this person's face in this session as an incorrect match: it stops teaching
// the matcher. The anchor stays (it is the face the person was created from, not a match).
/**
 * @param {Queryable} client
 * @param {string} personId
 * @param {string} sessionId
 */
export async function dropFromGallery(client, personId, sessionId) {
	await client.query(
		`UPDATE person_face_vectors SET in_gallery = false
		 WHERE person_id = $1 AND session_id = $2 AND NOT is_anchor`,
		[personId, sessionId]
	);
}
