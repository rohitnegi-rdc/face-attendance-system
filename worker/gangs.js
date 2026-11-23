// Pump gangs, phase 1 (migration 056). One place for the gang rules, used by the worker (inside the
// matching transaction) and by the app (submit, pump screen, reports):
// - Gangs are switched on per Area (areas.gangs_enabled). An Area left off runs exactly as before.
// - A worker is linked across the pumps of an Area by a clear face match (persons.area_worker_id);
//   a close call is never linked by itself, it waits for a plant manager (worker_link_candidates).
// - A shift start is tagged with the gang most of its faces belong to, else it starts a new gang
//   (its photo is the gang's source). A shift end belongs to its start's gang. No names anywhere.
// - On a "2 gangs today" pump the operator taps which running shift a photo ends, or "New gang".
//   The tap is only a hint: the faces decide (correctTap).
// - The same-day cross-pump fraud check is an admin switch, off unless the row says 'on'.

/** @typedef {{ query: (text: string, params?: any[]) => Promise<{ rows: any[], rowCount: number | null }> }} Db */

export const SAME_DAY_FRAUD_KEY = 'same_day_fraud_check';
// A face links to a worker at another pump of the Area only on a clear match: at least the gallery
// bar and clearly ahead of the next worker. Between the match threshold and this bar: ask a person.
export const LINK_THRESHOLD = 0.4;
export const LINK_MARGIN = 0.1;
// A photo belongs to a gang when more than half of its known workers are that gang's members.
export const GANG_SHARE = 0.5;
// Membership is read from the gang's most recent shifts, so a replaced worker drops out in time.
export const GANG_RECENT_SHIFTS = 5;
export const MAX_GANGS = 4;

/** @param {Db} db */
export async function sameDayFraudOn(db) {
	const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [
		SAME_DAY_FRAUD_KEY
	]);
	return rows[0]?.value === 'on';
}

/** @param {Db} db @param {string} pumpId */
export async function gangsOnForPump(db, pumpId) {
	const { rows } = await db.query(
		`SELECT a.gangs_enabled FROM pumps p JOIN plants pl ON pl.id = p.plant_id
		 JOIN areas a ON a.id = pl.area_id WHERE p.id = $1`,
		[pumpId]
	);
	return Boolean(rows[0]?.gangs_enabled);
}

// How many gangs the pump runs on `day`: the latest pump status row on or before that day (a status
// holds until the next change), 1 when the Area has gangs off.
/** @param {Db} db @param {string} pumpId @param {string} day */
export async function gangsForDay(db, pumpId, day) {
	if (!(await gangsOnForPump(db, pumpId))) return 1;
	const { rows } = await db.query(
		// "2 gangs today" is for that day only (a big pour), unlike the status, which carries on.
		'SELECT gangs FROM pump_day_status WHERE pump_id = $1 AND day = $2',
		[pumpId, day]
	);
	return Math.min(MAX_GANGS, Math.max(1, Number(rows[0]?.gangs ?? 1)));
}

/** @param {Db} db @param {string} personId @param {string} areaId */
export async function ensureAreaWorker(db, personId, areaId) {
	const { rows } = await db.query('SELECT area_worker_id FROM persons WHERE id = $1', [personId]);
	if (rows[0]?.area_worker_id) return rows[0].area_worker_id;
	const { rows: made } = await db.query(
		'INSERT INTO area_workers (area_id) VALUES ($1) RETURNING id',
		[areaId]
	);
	await db.query('UPDATE persons SET area_worker_id = $2 WHERE id = $1', [personId, made[0].id]);
	return made[0].id;
}

// A new person at this pump: is it a worker already known at another pump of the Area? Best gallery
// match per other person, then per area worker. Clear -> link (and copy the name); close -> ask.
/**
 * @param {Db} client
 * @param {{ personId: string, vector: string, areaId: string, pumpId: string, threshold: number }} input
 * @returns {Promise<'linked' | 'asked' | 'new'>}
 */
export async function linkNewPerson(client, { personId, vector, areaId, pumpId, threshold }) {
	const { rows } = await client.query(
		`SELECT p.id AS person_id, p.area_worker_id, p.name,
		        MAX(1 - (pfv.embedding <=> $1::vector)) AS similarity
		 FROM person_face_vectors pfv
		 JOIN persons p ON p.id = pfv.person_id
		 JOIN pumps pu ON pu.id = p.pump_id JOIN plants pl ON pl.id = pu.plant_id
		 WHERE pl.area_id = $2 AND p.pump_id <> $3 AND pfv.in_gallery
		   AND p.status IN ('active', 'pending_review')
		 GROUP BY p.id ORDER BY similarity DESC LIMIT 5`,
		[vector, areaId, pumpId]
	);
	const best = rows[0];
	if (!best || Number(best.similarity) < threshold) {
		await ensureAreaWorker(client, personId, areaId);
		return 'new';
	}
	// The runner-up is the best match that is a different worker.
	const runnerUp = rows.find(
		(r) =>
			r.person_id !== best.person_id &&
			(!best.area_worker_id || r.area_worker_id !== best.area_worker_id)
	);
	const margin = Number(best.similarity) - Number(runnerUp?.similarity ?? 0);
	if (Number(best.similarity) >= LINK_THRESHOLD && margin >= LINK_MARGIN) {
		const worker = await ensureAreaWorker(client, best.person_id, areaId);
		await client.query(
			`UPDATE persons SET area_worker_id = $2, name = COALESCE(name, $3) WHERE id = $1`,
			[personId, worker, best.name]
		);
		return 'linked';
	}
	await ensureAreaWorker(client, personId, areaId);
	await client.query(
		`INSERT INTO worker_link_candidates (person_id, other_person_id, similarity)
		 VALUES ($1, $2, $3) ON CONFLICT (person_id, other_person_id) DO NOTHING`,
		[personId, best.person_id, Number(best.similarity)]
	);
	return 'asked';
}

// The area workers in a session's photo (the operator included).
/** @param {Db} db @param {string} sessionId */
export async function sessionWorkers(db, sessionId) {
	const { rows } = await db.query(
		`SELECT DISTINCT COALESCE(p.area_worker_id, p.id) AS worker
		 FROM attendance_face_evidence e JOIN persons p ON p.id = e.person_id
		 WHERE e.session_id = $1`,
		[sessionId]
	);
	return rows.map((r) => String(r.worker));
}

// Members of every gang in the Area: the workers seen in its most recent shifts.
/** @param {Db} db @param {string} areaId */
export async function gangMembers(db, areaId) {
	const { rows } = await db.query(
		`WITH recent AS (
		   SELECT s.id, s.gang_id,
		          row_number() OVER (PARTITION BY s.gang_id ORDER BY s.submitted_at DESC) AS n
		   FROM attendance_sessions s JOIN gangs g ON g.id = s.gang_id
		   WHERE g.area_id = $1 AND s.status IN ('completed', 'review')
		 )
		 SELECT r.gang_id, array_agg(DISTINCT COALESCE(p.area_worker_id, p.id)::text) AS members
		 FROM recent r JOIN attendance_face_evidence e ON e.session_id = r.id
		 JOIN persons p ON p.id = e.person_id
		 WHERE r.n <= $2 GROUP BY r.gang_id`,
		[areaId, GANG_RECENT_SHIFTS]
	);
	return new Map(
		rows.map((r) => [String(r.gang_id), new Set(/** @type {string[]} */ (r.members))])
	);
}

// Which gang a set of workers is: the gang holding the largest share of them, if over half.
/**
 * @param {string[]} workers
 * @param {Map<string, Set<string>>} members
 * @returns {{ gangId: string, share: number } | null}
 */
export function pickGang(workers, members) {
	if (!workers.length) return null;
	/** @type {{ gangId: string, share: number } | null} */
	let best = null;
	for (const [gangId, set] of members) {
		const share = workers.filter((w) => set.has(w)).length / workers.length;
		if (share > GANG_SHARE && (!best || share > best.share)) best = { gangId, share };
	}
	return best;
}

// Tag a processed session with its gang. An end takes its start's gang; a start (or an end whose
// start has none) is matched against the Area's gangs, else it starts a new gang.
/**
 * @param {Db} client
 * @param {{ id: string, pump_id: string, session_type: string, paired_session_id: string | null }} session
 * @param {string} areaId
 * @returns {Promise<{ gangId: string, created: boolean } | null>}
 */
export async function tagGang(client, session, areaId) {
	if (session.session_type === 'evening' && session.paired_session_id) {
		const { rows } = await client.query('SELECT gang_id FROM attendance_sessions WHERE id = $1', [
			session.paired_session_id
		]);
		if (rows[0]?.gang_id) {
			await client.query('UPDATE attendance_sessions SET gang_id = $2 WHERE id = $1', [
				session.id,
				rows[0].gang_id
			]);
			return { gangId: rows[0].gang_id, created: false };
		}
	}
	const workers = await sessionWorkers(client, session.id);
	if (!workers.length) return null;
	const picked = pickGang(workers, await gangMembers(client, areaId));
	let gangId = picked?.gangId;
	const created = !gangId;
	if (!gangId) {
		const { rows } = await client.query(
			`INSERT INTO gangs (area_id, code, source_session_id, first_pump_id)
			 VALUES ($1, (SELECT COALESCE(MAX(code), 0) + 1 FROM gangs WHERE area_id = $1), $2, $3)
			 RETURNING id`,
			[areaId, session.id, session.pump_id]
		);
		gangId = rows[0].id;
	}
	await client.query('UPDATE attendance_sessions SET gang_id = $2 WHERE id = $1', [
		session.id,
		gangId
	]);
	if (session.session_type === 'morning') {
		// An end processed before its start was tagged follows it.
		await client.query(
			`UPDATE attendance_sessions SET gang_id = $2
			 WHERE paired_session_id = $1 AND session_type = 'evening' AND gang_id IS NULL`,
			[session.id, gangId]
		);
	}
	return { gangId: /** @type {string} */ (gangId), created };
}

// The faces decide which running shift a photo belongs to, whatever the operator tapped. Only on a
// pump running more than one gang today. `matched` are the pump persons matched in the photo.
//   - an end whose faces mostly belong to another running start (past its gap) moves to that start;
//   - a "new gang" start whose faces mostly belong to a running start past its gap becomes its end.
// Returns the session fields to use for the attendance writes (unchanged when nothing moved).
/**
 * @param {Db} client
 * @param {{ id: string, pump_id: string, session_type: string, session_date: string, gang_slot: number, paired_session_id: string | null }} session
 * @param {string[]} matched
 * @param {number} gapMinutes
 */
export async function correctTap(client, session, matched, gapMinutes) {
	const unchanged = { ...session, moved: /** @type {string | null} */ (null) };
	if (!matched.length) return unchanged;
	const { rows: starts } = await client.query(
		`SELECT s.id, s.session_date::text AS session_date, s.gang_slot, s.pairing_status,
		        s.paired_session_id,
		        EXTRACT(EPOCH FROM (now() - s.submitted_at)) / 60 AS elapsed,
		        array_agg(DISTINCT e.person_id::text) FILTER (WHERE e.person_id IS NOT NULL) AS people
		 FROM attendance_sessions s
		 LEFT JOIN attendance_face_evidence e ON e.session_id = s.id
		 WHERE s.pump_id = $1 AND s.session_type = 'morning' AND s.id <> $2
		   AND s.status = 'completed'
		   AND (s.pairing_status = 'open' OR s.paired_session_id = $2)
		 GROUP BY s.id`,
		[session.pump_id, session.id]
	);
	if (!starts.length) return unchanged;
	const share = (/** @type {string[] | null} */ people) =>
		matched.filter((m) => (people ?? []).includes(m)).length / matched.length;
	const ranked = starts
		.map((s) => ({ ...s, share: share(s.people) }))
		.sort((a, b) => b.share - a.share);
	const best = ranked[0];
	if (best.share <= GANG_SHARE) return unchanged;

	if (session.session_type === 'evening') {
		if (best.id === session.paired_session_id) return unchanged;
		if (best.pairing_status !== 'open' || Number(best.elapsed) < gapMinutes) return unchanged;
		// Re-pair: the tapped start opens again, the end moves to the start its faces belong to.
		await client.query(
			`UPDATE attendance_sessions SET pairing_status = 'open', paired_session_id = NULL
			 WHERE id = $1`,
			[session.paired_session_id]
		);
		await client.query(
			`UPDATE attendance_sessions SET paired_session_id = $2, session_date = $3, gang_slot = $4
			 WHERE id = $1`,
			[session.id, best.id, best.session_date, best.gang_slot]
		);
		await client.query(
			`UPDATE attendance_sessions SET pairing_status = 'paired', paired_session_id = $2
			 WHERE id = $1`,
			[best.id, session.id]
		);
		return {
			...session,
			session_date: best.session_date,
			gang_slot: best.gang_slot,
			paired_session_id: best.id,
			moved: 'repaired'
		};
	}
	// A "new gang" start that is really a running gang's end.
	if (best.pairing_status !== 'open' || Number(best.elapsed) < gapMinutes) return unchanged;
	await client.query(
		`UPDATE attendance_sessions
		 SET session_type = 'evening', pairing_status = 'paired', paired_session_id = $2,
		     session_date = $3, gang_slot = $4
		 WHERE id = $1`,
		[session.id, best.id, best.session_date, best.gang_slot]
	);
	await client.query(
		`UPDATE attendance_sessions SET pairing_status = 'paired', paired_session_id = $2 WHERE id = $1`,
		[best.id, session.id]
	);
	await client.query(
		`UPDATE attendance_photo_backups SET session_type = 'evening', session_date = $2
		 WHERE session_id = $1`,
		[session.id, best.session_date]
	);
	return {
		...session,
		session_type: 'evening',
		session_date: best.session_date,
		gang_slot: best.gang_slot,
		paired_session_id: best.id,
		moved: 'start_became_end'
	};
}

/**
 * Gang headcount rows between two days for the pumps a scope condition allows. `pumpWhere` is a
 * condition over pu (pumps), pl (plants), a (areas), v (vendors) using the given params; the
 * from/to placeholders come after them. One row per gang, pump and day (`people` = workers once),
 * plus `worker_ids` so callers can count a worker once across pumps. Shared by the app
 * (src/lib/server/gangs.ts) and the 9 am email (worker/attendanceDigest.js).
 * @param {string} pumpWhere
 * @param {number} firstFree
 */
export function gangDaySql(pumpWhere, firstFree) {
	const FROM = `$${firstFree}`;
	const TO = `$${firstFree + 1}`;
	return `WITH scope AS (
		SELECT pu.id FROM pumps pu JOIN vendors v ON v.id = pu.vendor_id
		JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		WHERE a.gangs_enabled AND (${pumpWhere})
	),
	gang_sessions AS (
		SELECT s.id, s.pump_id, s.session_date, s.gang_id, s.gang_slot, s.submitted_at,
		       s.session_type, s.location_status
		FROM attendance_sessions s JOIN scope ON scope.id = s.pump_id
		WHERE s.gang_id IS NOT NULL AND s.status IN ('review', 'completed')
		  AND s.session_date BETWEEN ${FROM} AND ${TO}
	),
	pump_day_gangs AS (
		SELECT pump_id, session_date, count(DISTINCT gang_id)::int AS gangs,
		       (array_agg(gang_id ORDER BY gang_slot, submitted_at))[1] AS first_gang
		FROM gang_sessions GROUP BY 1, 2
	),
	present AS (
		SELECT d.person_id, d.pump_id, d.session_date, COALESCE(p.area_worker_id, p.id) AS worker
		FROM daily_person_attendance d JOIN scope ON scope.id = d.pump_id
		JOIN persons p ON p.id = d.person_id AND p.status <> 'merged'
		WHERE d.session_date BETWEEN ${FROM} AND ${TO} AND (d.morning_matched OR d.evening_matched)
		  AND NOT EXISTS (
		    SELECT 1 FROM attendance_duplicate_resolutions r
		    WHERE r.duplicate_person_id = d.person_id AND r.session_date = d.session_date
		      AND r.reversed_at IS NULL)
	),
	assigned AS (
		SELECT pr.pump_id, pr.session_date, pr.worker,
		       CASE WHEN pdg.gangs = 1 THEN pdg.first_gang ELSE COALESCE((
		         SELECT gs.gang_id FROM gang_sessions gs
		         JOIN attendance_face_evidence e ON e.session_id = gs.id
		         JOIN persons ep ON ep.id = e.person_id
		         WHERE gs.pump_id = pr.pump_id AND gs.session_date = pr.session_date
		           AND COALESCE(ep.merged_into_person_id, ep.id) = pr.person_id
		         ORDER BY gs.session_type, gs.submitted_at LIMIT 1), pdg.first_gang) END AS gang_id
		FROM present pr JOIN pump_day_gangs pdg
		  ON pdg.pump_id = pr.pump_id AND pdg.session_date = pr.session_date
	),
	held AS (
		SELECT gang_id, pump_id, session_date, max(location_status) AS held
		FROM gang_sessions
		WHERE session_type = 'morning' AND location_status IN ('pending', 'rejected')
		GROUP BY 1, 2, 3
	),
	gang_pump_days AS (
		SELECT DISTINCT gang_id, pump_id, session_date FROM gang_sessions
	)
	SELECT gpd.gang_id, gpd.pump_id, gpd.session_date::text AS session_date,
	       count(DISTINCT a.worker)::int AS people,
	       COALESCE(array_agg(DISTINCT a.worker::text) FILTER (WHERE a.worker IS NOT NULL), '{}') AS worker_ids,
	       h.held
	FROM gang_pump_days gpd
	LEFT JOIN assigned a ON a.gang_id = gpd.gang_id AND a.pump_id = gpd.pump_id
	  AND a.session_date = gpd.session_date
	LEFT JOIN held h ON h.gang_id = gpd.gang_id AND h.pump_id = gpd.pump_id
	  AND h.session_date = gpd.session_date
	GROUP BY gpd.gang_id, gpd.pump_id, gpd.session_date, h.held`;
}
