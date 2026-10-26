// Background worker — plans/MasterPlan.md §2/§4/Prompt A "ASYNC part".
// Polls the Postgres-backed job queue, calls the AI microservice, runs the
// Area-scoped symmetric fraud check + local match / auto-create, and writes
// attendance. Runs as its own process/container (docker-compose "worker").
import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sendFraudAlertEmail } from './mailer.js';
import { checkRecapture } from './recaptureCheck.js';
import { pollPumpGps } from './gpsFeed.js';
import { sendEndReminders } from './endReminders.js';
import {
	assignFaces,
	findCrossPumpMatch,
	findLocalCandidates,
	galleryRules,
	keepsInGallery,
	saveFace
} from './faceQueries.js';

const { Pool } = pg;
const WORKER_ID = process.env.HOSTNAME || `worker-${process.pid}`;
const HEARTBEAT_INTERVAL_MS = Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? 5000);
// max sized to comfortably exceed WORKER_BATCH_SIZE concurrent jobs (each job holds at most
// one client during its brief locked write phase, plus short-lived query connections).
const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	max: Number(process.env.DB_POOL_MAX ?? 10)
});

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://ai-service:8000';
// Same default and parsing as src/lib/server/matching.ts (0.28, from the golden small-group
// evaluation). An empty or invalid env value falls back to the default instead of becoming 0.
const FACE_MATCH_THRESHOLD = (() => {
	const value = Number(process.env.FACE_MATCH_THRESHOLD?.trim() || NaN);
	return value > 0 && value < 1 ? value : 0.28;
})();
const POLL_INTERVAL_MS = 1500;
// When a matched face may join the person's gallery (faceQueries.js, GALLERY).
const GALLERY_RULES = galleryRules(FACE_MATCH_THRESHOLD);
const CLAIM_TIMEOUT_MINUTES = Number(process.env.JOB_CLAIM_TIMEOUT_MINUTES ?? 10);
const MAX_JOB_ATTEMPTS = Number(process.env.MAX_JOB_ATTEMPTS ?? 3);
const AI_REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 30000);
// A failed attempt waits base, then 2x base, ... before the next one, so an AI-service restart
// (model load) does not use up every attempt within seconds. 20s gives 20s + 40s of cover.
const JOB_RETRY_BASE_SECONDS = Number(process.env.JOB_RETRY_BASE_SECONDS ?? 20);
// How often jobs that can never run again (attempt limit reached) are marked failed.
const STUCK_JOB_SWEEP_SECONDS = Number(process.env.STUCK_JOB_SWEEP_SECONDS ?? 30);
// Jobs claimed per poll and processed concurrently, so their (dominant) AI-extraction calls
// overlap instead of running one-after-another — this is what actually shortens a same-Area
// burst, since the Area lock (see processJob) is now only held for the brief DB write phase.
const WORKER_BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE ?? 4);
// This is database-backed backpressure. Uploads are still accepted into the durable queue,
// but no more than this many jobs may be claimed for active work at a time.
const MAX_ACTIVE_ATTENDANCE_JOBS = Number(process.env.MAX_ACTIVE_ATTENDANCE_JOBS ?? 30);
// How many times to retry Phase 3 (see processJob) on a genuine SERIALIZABLE conflict before
// giving up and falling through to the normal job-attempt retry path.
const SERIALIZATION_RETRY_LIMIT = Number(process.env.SERIALIZATION_RETRY_LIMIT ?? 5);
// Falsified-photo check (whole-photo spoof model + Gemini recapture) that disables the pump.
// Off by default for v1. The cross-pump Area check below is not affected by this switch.
const PHOTO_SPOOF_CHECK_ENABLED = process.env.PHOTO_SPOOF_CHECK_ENABLED === 'true';

// The pump screen shows the session's error_reason, so it gets a sentence an operator can act
// on. The technical error stays in attendance_jobs.last_error and the log.
class AiServiceError extends Error {}
// The operator photo has no face. Retrying the same photo cannot help, so it fails at once.
class OperatorPhotoError extends Error {}

function userFacingReason(err) {
	if (err instanceof AiServiceError) {
		return 'The face service did not answer. Tap Retry, or contact Admin if it keeps happening.';
	}
	if (err instanceof OperatorPhotoError) {
		return 'No face was found in the operator photo. Tap Retry and take a clear photo of the operator.';
	}
	if (err?.code === 'ENOENT') {
		return 'The photo file is missing on the server. Tap Retry and take the photo again.';
	}
	return 'The photo could not be processed. Tap Retry, or contact Admin if it keeps happening.';
}

function isSerializationConflict(err) {
	// 40001 = serialization_failure (SSI conflict under SERIALIZABLE), 40P01 = deadlock_detected.
	return err?.code === '40001' || err?.code === '40P01';
}

// ISO 8601 in Asia/Kolkata, computed in code; same as istTimestamp in src/lib/server/log.ts.
function istTimestamp(date = new Date()) {
	return new Date(date.getTime() + 330 * 60_000).toISOString().replace('Z', '+05:30');
}

const STORED_LOG_LEVELS = new Set(['warn', 'error', 'fatal']);
const MAX_LOG_DETAILS_CHARS = 8000;
const LOG_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS) || 30;

// Same line shape as the app (src/lib/server/log.ts). Warnings and errors also go to
// system_logs for the admin Logs page; a failed insert only writes to stderr, never loops.
function log(level, fields, message) {
	console.log(
		JSON.stringify({ timestamp: istTimestamp(), level, service: 'worker', message, ...fields })
	);
	if (!STORED_LOG_LEVELS.has(level)) return;
	let details = JSON.stringify(fields);
	if (details.length > MAX_LOG_DETAILS_CHARS) {
		details = JSON.stringify({ truncated: details.slice(0, MAX_LOG_DETAILS_CHARS) });
	}
	const text = (value) => (value == null || value === '' ? null : String(value));
	pool
		.query(
			`INSERT INTO system_logs (level, service, message, request_id, session_id, pump_id, details)
			 VALUES ($1, 'worker', $2, $3, $4, $5, $6::jsonb)`,
			[
				level,
				message || '(no message)',
				text(fields.requestId ?? fields.request_id),
				text(fields.sessionId ?? fields.session_id),
				text(fields.pumpId ?? fields.pump_id),
				details
			]
		)
		.catch((err) => {
			console.error(
				JSON.stringify({
					timestamp: istTimestamp(),
					level: 'error',
					service: 'worker',
					message: 'could not store log line',
					error: String(err?.message || err)
				})
			);
		});
}

async function writeHeartbeat() {
	await pool.query(
		`INSERT INTO worker_heartbeats (worker_id, last_seen_at) VALUES ($1, now())
		 ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
		[WORKER_ID]
	);
}

async function claimJobBatch(limit) {
	const requestedLimit = Math.min(limit, MAX_ACTIVE_ATTENDANCE_JOBS);
	const { rows } = await pool.query(
		`UPDATE attendance_jobs AS job
		 SET status = 'claimed', claimed_at = now(), claimed_by = $5, attempts = attempts + 1,
		     last_error = NULL
		 FROM (
		   SELECT id
		   FROM attendance_jobs
		   WHERE attempts < $2
		     AND (
		       (status = 'queued' AND available_at <= now())
		       OR (status = 'claimed' AND claimed_at < now() - ($1 || ' minutes')::interval)
		     )
		   ORDER BY created_at ASC
		   LIMIT LEAST(
		     $3,
		     GREATEST(0, $4 - (SELECT count(*)::int FROM attendance_jobs WHERE status = 'claimed'))
		   )
		   FOR UPDATE SKIP LOCKED
		 ) AS candidate
		 WHERE job.id = candidate.id
		 RETURNING job.*`,
		[CLAIM_TIMEOUT_MINUTES, MAX_JOB_ATTEMPTS, requestedLimit, MAX_ACTIVE_ATTENDANCE_JOBS, WORKER_ID]
	);
	return rows;
}

// A worker that starts with jobs still claimed under its own name crashed while holding them
// (in Docker the name is the container hostname, which survives a restart). Nothing else is
// working on them, so hand them back now rather than after CLAIM_TIMEOUT_MINUTES.
async function releaseOwnClaims() {
	const { rows } = await pool.query(
		`WITH released AS (
		   UPDATE attendance_jobs
		   SET status = 'queued', claimed_at = NULL, claimed_by = NULL, available_at = now(),
		       last_error = 'worker restarted while processing'
		   WHERE status = 'claimed' AND claimed_by = $1
		   RETURNING session_id
		 )
		 UPDATE attendance_sessions s SET status = 'pending'
		 FROM released WHERE s.id = released.session_id AND s.status = 'processing'
		 RETURNING s.id`,
		[WORKER_ID]
	);
	return rows.length;
}

// Jobs that hit the attempt limit without finishing can never be claimed again: a worker that
// died during the last attempt leaves one 'claimed', a restart hand-back can leave one 'queued'.
// Fail them so the pump sees Retry instead of an endless "processing", and so /api/health stops
// counting them as stale (which also failed every deploy health check).
async function failStuckJobs() {
	const { rows } = await pool.query(
		`WITH stuck AS (
		   UPDATE attendance_jobs
		   SET status = 'error', claimed_at = NULL,
		       last_error = COALESCE(last_error, 'worker stopped while processing')
		   WHERE attempts >= $2
		     AND (status = 'queued'
		          OR (status = 'claimed' AND claimed_at < now() - ($1 || ' minutes')::interval))
		   RETURNING session_id
		 ),
		 kept AS (
		   UPDATE attendance_photo_backups b
		   SET status = 'failed', reason = $3, error_detail = 'attempt limit reached', kept_at = now()
		   FROM stuck WHERE b.session_id = stuck.session_id AND b.status = 'waiting'
		 )
		 UPDATE attendance_sessions s SET status = 'failed', error_reason = $3
		 FROM stuck WHERE s.id = stuck.session_id AND s.status IN ('pending', 'processing')
		 RETURNING s.id`,
		[
			CLAIM_TIMEOUT_MINUTES,
			MAX_JOB_ATTEMPTS,
			'Processing stopped before it finished. Tap Retry, or contact Admin if it keeps happening.'
		]
	);
	return rows.length;
}

// The untouched upload copy (db/migrations/025_photo_backups.sql). A photo that fails or is
// flagged as fraud keeps it forever; one processed cleanly has its own photo, so the copy goes.
// Only a 'waiting' copy changes: once kept, a later reprocess (admin "mark normal") leaves it.
// Both only log on error: the session outcome is already saved and must not turn into a failure.
async function keepBackup(sessionId, status, reason, detail = null) {
	try {
		await pool.query(
			`UPDATE attendance_photo_backups
			 SET status = $2, reason = $3, error_detail = $4, kept_at = now()
			 WHERE session_id = $1 AND status = 'waiting'`,
			[sessionId, status, reason, detail]
		);
	} catch (err) {
		log('error', { sessionId, error: String(err?.message || err) }, 'could not keep photo backup');
	}
}

async function dropBackup(sessionId) {
	try {
		const { rows } = await pool.query(
			`DELETE FROM attendance_photo_backups WHERE session_id = $1 AND status = 'waiting'
			 RETURNING file_path`,
			[sessionId]
		);
		await Promise.all(rows.map((row) => fs.unlink(row.file_path).catch(() => {})));
	} catch (err) {
		log('error', { sessionId, error: String(err?.message || err) }, 'could not drop photo backup');
	}
}

function cosineSimilarity(a, b) {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	return dot / Math.sqrt(normA * normB);
}

// The operator photo should hold one person; if others got in, the biggest face is the operator.
function largestFace(faces) {
	const area = (face) =>
		Array.isArray(face.bbox) ? (face.bbox[2] - face.bbox[0]) * (face.bbox[3] - face.bbox[1]) : 0;
	return faces.reduce((best, face) => (!best || area(face) > area(best) ? face : best), null);
}

// Adds the operator to the session's faces. If the operator is also in the group photo, that
// group face is marked as the operator instead, so the same person is counted once.
function withOperatorFace(groupFaces, operatorFace) {
	const faces = [...groupFaces];
	if (!operatorFace) return faces;
	let bestIndex = -1;
	let bestSimilarity = -1;
	faces.forEach((face, index) => {
		const similarity = cosineSimilarity(face.embedding, operatorFace.embedding);
		if (similarity > bestSimilarity) {
			bestSimilarity = similarity;
			bestIndex = index;
		}
	});
	if (bestIndex >= 0 && bestSimilarity >= FACE_MATCH_THRESHOLD) {
		faces[bestIndex] = { ...faces[bestIndex], is_operator: true };
	} else {
		faces.push({ ...operatorFace, is_operator: true });
	}
	return faces;
}

function toVectorLiteral(embedding) {
	return `[${embedding.join(',')}]`;
}

async function extractFaces(photoBuffer, requestId) {
	const form = new FormData();
	form.append('file', new Blob([photoBuffer]), 'photo.jpg');
	let res;
	try {
		res = await fetch(`${AI_SERVICE_URL}/internal/face/extract`, {
			method: 'POST',
			headers: { 'x-request-id': requestId },
			body: form,
			signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS)
		});
	} catch (err) {
		throw new AiServiceError(`AI service unreachable: ${err?.message || err}`);
	}
	if (!res.ok) throw new AiServiceError(`AI service returned ${res.status}`);
	try {
		return await res.json();
	} catch (err) {
		throw new AiServiceError(`AI service sent an unreadable answer: ${err?.message || err}`);
	}
}

// Same precedence as src/lib/server/settings.ts: admin setting > env > default (24h).
async function pairingWindowHours(db) {
	const { rows } = await db.query(
		`SELECT value FROM app_settings WHERE key = 'evening_pairing_window_hours'`
	);
	const stored = Number(rows[0]?.value);
	if (Number.isFinite(stored) && stored > 0) return stored;
	const fromEnv = Number(process.env.EVENING_PAIRING_WINDOW_HOURS);
	return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 24;
}

// Same switch as getTestMode in src/lib/server/settings.ts (admin, /admin/settings): while on,
// the cross-pump fraud check is off and the fraud alert email is logged instead of sent.
async function testModeOn(db) {
	const { rows } = await db.query(`SELECT value FROM app_settings WHERE key = 'test_mode'`);
	return rows[0]?.value === 'true';
}

async function expireStaleMornings(db) {
	const windowHours = await pairingWindowHours(db);
	const { rows } = await db.query(
		`WITH expired AS (
		   UPDATE attendance_sessions
		   SET pairing_status = 'expired', closed_by = 'timeout', closed_at = now()
		   WHERE session_type = 'morning'
		     AND status = 'completed'
		     AND pairing_status = 'open'
		     AND now() - submitted_at > ($1 || ' hours')::interval
		   RETURNING id, pump_id, session_date
		 ),
		 finalized AS (
		   INSERT INTO attendance_rollup_finalizations (pump_id, session_date, session_id)
		   SELECT pump_id, session_date, id FROM expired
		   ON CONFLICT (pump_id, session_date) DO NOTHING
		   RETURNING pump_id, session_date
		 ),
		 yearly AS (
		   INSERT INTO person_attendance_yearly (person_id, year, days_morning_only)
		   SELECT dpa.person_id, EXTRACT(YEAR FROM dpa.session_date)::int, 1
		   FROM daily_person_attendance dpa
		   JOIN finalized f
		     ON f.pump_id = dpa.pump_id AND f.session_date = dpa.session_date
		   WHERE dpa.morning_matched AND NOT dpa.evening_matched
		   ON CONFLICT (person_id, year)
		   DO UPDATE SET
		     days_morning_only = person_attendance_yearly.days_morning_only + 1,
		     last_updated = now()
		 )
		 SELECT count(*)::int AS expired_count FROM expired`,
		[windowHours]
	);
	return rows[0]?.expired_count ?? 0;
}

async function processJob(job) {
	const requestId = job.request_id;
	try {
		// Phase 1 — fast read-only lookups, no transaction, no lock held.
		const { rows: sessRows } = await pool.query('SELECT * FROM attendance_sessions WHERE id = $1', [
			job.session_id
		]);
		const session = sessRows[0];
		if (!session) throw new Error('session not found');

		const { rows: pumpRows } = await pool.query(
			`SELECT pu.*, pl.area_id FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id WHERE pu.id = $1`,
			[session.pump_id]
		);
		const pump = pumpRows[0];
		const areaId = pump.area_id;

		await pool.query(`UPDATE attendance_sessions SET status = 'processing' WHERE id = $1`, [
			session.id
		]);

		// Phase 2 — AI extraction (the slow, multi-second step). Deliberately outside any
		// transaction/lock: it touches nothing that needs Area-wide exclusivity, so holding
		// the Area lock across it would only serialize same-Area jobs for no reason. Multiple
		// jobs (see loop()) run this phase concurrently, which is what actually shortens a
		// same-Area burst.
		const photoBuffer = await fs.readFile(session.photo_url);
		// Sessions from before the operator photo (030_operator_photo.sql) have none.
		const operatorBuffer = session.operator_photo_url
			? await fs.readFile(session.operator_photo_url)
			: null;
		const extractStart = Date.now();
		const [extraction, operatorExtraction, recaptureCheck] = await Promise.all([
			extractFaces(photoBuffer, requestId),
			operatorBuffer ? extractFaces(operatorBuffer, requestId) : Promise.resolve(null),
			!PHOTO_SPOOF_CHECK_ENABLED
				? Promise.resolve({ status: 'disabled' })
				: session.fraud_resolution === 'marked_normal'
					? Promise.resolve({ status: 'skipped_marked_normal' })
					: checkRecapture(photoBuffer)
		]);
		const operatorFace = operatorExtraction ? largestFace(operatorExtraction.faces || []) : null;
		if (operatorExtraction && !operatorFace)
			throw new OperatorPhotoError('no face in operator photo');
		const {
			faces: groupFaces,
			image_preprocessing: imagePreprocessing,
			normalized_photo_base64: normalizedPhotoBase64,
			whole_image_liveness: wholeImageLiveness
		} = extraction;
		if (normalizedPhotoBase64) {
			await fs.writeFile(session.photo_url, Buffer.from(normalizedPhotoBase64, 'base64'));
		}
		const faces = withOperatorFace(groupFaces, operatorFace);
		const extractMs = Date.now() - extractStart;
		const livenessSummary = faces.reduce(
			(summary, face) => {
				const status = ['live', 'suspicious', 'unverified'].includes(face.liveness_status)
					? face.liveness_status
					: 'unverified';
				summary[status] += 1;
				summary.inference_ms += Number(face.liveness_inference_ms || 0);
				return summary;
			},
			{ live: 0, suspicious: 0, unverified: 0, inference_ms: 0 }
		);
		await pool.query(
			`UPDATE attendance_sessions
			 SET processing_metadata = COALESCE(processing_metadata, '{}'::jsonb) || $2::jsonb
			 WHERE id = $1`,
			[
				session.id,
				JSON.stringify({
					ai_extraction_ms: extractMs,
					operator_faces_detected: operatorExtraction ? operatorExtraction.faces.length : null,
					image_preprocessing: imagePreprocessing || null,
					anti_spoofing: livenessSummary,
					whole_image_liveness: wholeImageLiveness || null,
					recapture_check: recaptureCheck
				})
			]
		);

		// Phase 3 — optimistic concurrency instead of a blocking Area lock. Every job — even
		// same-Area, same-date — can enter this phase concurrently; nothing blocks. Instead the
		// whole match+write step runs under Postgres SERIALIZABLE isolation, which tracks what
		// each concurrent transaction actually read and wrote and aborts one side with a
		// serialization_failure (40001) if committing both would be impossible under any
		// one-at-a-time ordering — i.e. exactly the race the old per-Area advisory lock
		// prevented by blocking, caught here after the fact instead of before. On that error we
		// retry the whole phase from scratch (cheap: it's DB-only, the AI call above is not
		// repeated) up to SERIALIZATION_RETRY_LIMIT times. See docs/Architecture.md §9.
		log(
			'info',
			{
				requestId,
				sessionId: session.id,
				areaId,
				extractMs,
				facesDetected: faces.length,
				imagePreprocessing,
				livenessSummary,
				wholeImageLiveness,
				recaptureCheck
			},
			'ai extraction complete'
		);

		// Whole-photo spoof fraud — the whole submitted photo is a re-photograph of a screen or
		// printed image, not one odd face in an otherwise-real group photo (that per-face case is
		// left alone and still matches/marks present as usual). Checked before any matching so a
		// fraudulent photo never touches the roster, gallery, or attendance totals.
		//
		// Driven by whole_image_liveness (ai-service: AntiSpoofingEngine.predict_whole_image),
		// which runs the anti-spoof model on the full frame instead of voting across small
		// per-face crops. Verified against a real screen-replay test photo: per-face crops gave
		// [0.08, 0.31, 0.98(!), 0.14] — one bad crop-level read away from being missed entirely —
		// while the whole-frame call scored it 99.96% "screen replay" with no ambiguity. Per-face
		// scores stay exactly as before for the "needs review" UI on otherwise-real photos.
		// A session an admin has already reviewed and marked normal must never re-trigger this,
		// even on a later retry of the same job — otherwise "mark as normal" would just requeue
		// straight back into the same fraud verdict on the same photo.
		// Gemini recapture check (worker/recaptureCheck.js) catches screen photos the whole-frame
		// model misses, e.g. a laptop screen that is small in the frame. An API error never blocks.
		const isSessionFraud =
			PHOTO_SPOOF_CHECK_ENABLED &&
			session.fraud_resolution !== 'marked_normal' &&
			(wholeImageLiveness?.liveness_status === 'suspicious' ||
				recaptureCheck?.status === 'recapture');
		if (isSessionFraud) {
			const disabledReason = `spoof_fraud_session:${session.id}`;
			await pool.query(
				`UPDATE attendance_sessions
				 SET status = 'fraud_detected',
				     pairing_status = CASE WHEN pairing_status = 'open' THEN 'expired' ELSE pairing_status END,
				     error_reason = 'spoof_detected_session',
				     processed_at = now()
				 WHERE id = $1`,
				[session.id]
			);
			await pool.query(`UPDATE attendance_jobs SET status = 'done' WHERE id = $1`, [job.id]);
			await keepBackup(session.id, 'fraud', 'Photo of a screen or a printed photo');
			await pool.query(
				`UPDATE pumps SET status = 'disabled', disabled_at = now(), disabled_reason = $2
				 WHERE id = $1 AND status = 'active'`,
				[session.pump_id, disabledReason]
			);
			log(
				'warn',
				{
					requestId,
					sessionId: session.id,
					pumpId: session.pump_id,
					areaId,
					facesDetected: faces.length,
					livenessSummary,
					wholeImageLiveness,
					recaptureCheck
				},
				'session-level spoof fraud detected — pump disabled'
			);

			const { rows: plantRows } = await pool.query(
				`SELECT pl.name AS plant_name, pl.manager_name, pl.manager_email, a.name AS area_name
				 FROM plants pl JOIN areas a ON a.id = pl.area_id WHERE pl.id = $1`,
				[pump.plant_id]
			);
			const plantInfo = plantRows[0] || {};
			if (await testModeOn(pool)) {
				log(
					'info',
					{ requestId, sessionId: session.id, pumpCode: pump.pump_code },
					'fraud alert email NOT sent (test mode)'
				);
				return;
			}
			await sendFraudAlertEmail(
				{
					plantManagerEmail: plantInfo.manager_email,
					plantManagerName: plantInfo.manager_name,
					plantName: plantInfo.plant_name,
					areaName: plantInfo.area_name,
					pumpCode: pump.pump_code,
					sessionType: session.session_type,
					sessionDate: session.session_date,
					photoBuffer,
					photoFilename: path.basename(session.photo_url)
				},
				log
			);
			return;
		}

		const skipFraudCheck = await testModeOn(pool);
		if (skipFraudCheck) {
			log('warn', { requestId, sessionId: session.id }, 'cross-pump fraud check off (test mode)');
		}

		let matchedPersons, newPersons, fraudFlags;
		for (let attempt = 0; ; attempt++) {
			const client = await pool.connect();
			try {
				await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

				matchedPersons = [];
				newPersons = [];
				fraudFlags = [];
				/** @type {{ face: any, vec: string, candidates: { person_id: string, similarity: number }[] }[]} */
				const localFaces = [];

				for (const face of faces) {
					const vec = toVectorLiteral(face.embedding);

					// CROSS-PUMP CHECK (faceQueries.js): Area-scoped, same-shift-date faces only.
					// Skipped only while an admin has test mode on (testModeOn).
					const crossMatch = skipFraudCheck
						? undefined
						: await findCrossPumpMatch(client, {
								vector: vec,
								sessionDate: session.session_date,
								areaId,
								pumpId: session.pump_id
							});

					if (crossMatch && crossMatch.similarity >= FACE_MATCH_THRESHOLD) {
						await client.query(
							// The face is skipped below, so keep it on the flag: an admin who rules the
							// flag "not fraud" needs it to mark this worker present at this pump.
							`INSERT INTO fraud_flags (session_id, person_id, matched_at_pump_id, matched_session_id,
					                          similarity_score, face_embedding, face_crop_url, is_operator)
					 VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)`,
							[
								session.id,
								crossMatch.person_id,
								crossMatch.pump_id,
								crossMatch.matched_session_id,
								crossMatch.similarity,
								vec,
								face.crop_base64 ? `data:image/jpeg;base64,${face.crop_base64}` : null,
								Boolean(face.is_operator)
							]
						);
						fraudFlags.push({ person_id: crossMatch.person_id, similarity: crossMatch.similarity });
						log(
							'warn',
							{
								requestId,
								sessionId: session.id,
								personId: crossMatch.person_id,
								similarity: crossMatch.similarity
							},
							'fraud flag raised'
						);
						continue;
					}

					// LOCAL MATCH (faceQueries.js): this pump's own gallery, new workers included.
					// Enough candidates for a face to fall back past every other face in the photo.
					localFaces.push({
						face,
						vec,
						candidates: await findLocalCandidates(client, {
							vector: vec,
							pumpId: session.pump_id,
							limit: faces.length + 1
						})
					});
				}

				// One face per person, strongest match first (faceQueries.js assignFaces). People are
				// created only after every face is matched, so no face can match a worker this
				// photo creates.
				const assigned = assignFaces(
					localFaces.map((local) => local.candidates),
					FACE_MATCH_THRESHOLD
				);
				for (const [index, { face, vec }] of localFaces.entries()) {
					const localMatch = assigned[index];
					let personId;
					// A new person's face is their anchor; a matched face joins the gallery only
					// when the match is clear, so a wrong match cannot teach the matcher.
					let inGallery = true;
					let isAnchor = false;
					if (localMatch) {
						inGallery = keepsInGallery(localMatch, GALLERY_RULES);
						personId = localMatch.person_id;
						await client.query(
							`UPDATE persons SET last_seen_at = now(), is_operator = is_operator OR $2 WHERE id = $1`,
							[personId, Boolean(face.is_operator)]
						);
						matchedPersons.push({ person_id: personId, similarity: localMatch.similarity });
					} else {
						const { rows: created } = await client.query(
							`INSERT INTO persons (pump_id, status, display_seq, is_operator)
					 VALUES ($1, 'pending_review', (SELECT COALESCE(MAX(display_seq), 0) + 1 FROM persons WHERE pump_id = $1), $2)
					 RETURNING id`,
							[session.pump_id, Boolean(face.is_operator)]
						);
						personId = created[0].id;
						isAnchor = true;
						newPersons.push({ person_id: personId });
						log('info', { requestId, sessionId: session.id, personId }, 'auto-created new person');
					}

					await saveFace(client, {
						personId,
						sessionId: session.id,
						vector: vec,
						cropUrl: face.crop_base64 ? `data:image/jpeg;base64,${face.crop_base64}` : null,
						inGallery,
						isAnchor
					});
					await client.query(
						`INSERT INTO attendance_face_evidence
				   (session_id, person_id, face_crop_url, match_confidence, liveness_status,
				    liveness_score, liveness_quality, liveness_reason, liveness_model, liveness_inference_ms,
				    is_operator)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
				 ON CONFLICT (session_id, person_id) DO UPDATE SET
				   is_operator = attendance_face_evidence.is_operator OR EXCLUDED.is_operator,
				   face_crop_url = EXCLUDED.face_crop_url,
				   match_confidence = EXCLUDED.match_confidence,
				   liveness_status = EXCLUDED.liveness_status,
				   liveness_score = EXCLUDED.liveness_score,
				   liveness_quality = EXCLUDED.liveness_quality,
				   liveness_reason = EXCLUDED.liveness_reason,
				   liveness_model = EXCLUDED.liveness_model,
				   liveness_inference_ms = EXCLUDED.liveness_inference_ms`,
						[
							session.id,
							personId,
							face.crop_base64 ? `data:image/jpeg;base64,${face.crop_base64}` : null,
							localMatch?.similarity ?? null,
							['live', 'suspicious', 'unverified'].includes(face.liveness_status)
								? face.liveness_status
								: 'unverified',
							face.liveness_score ?? null,
							face.liveness_quality === 'sufficient' ? 'sufficient' : 'insufficient',
							face.liveness_reason ?? null,
							face.liveness_model ?? null,
							face.liveness_inference_ms ?? null,
							Boolean(face.is_operator)
						]
					);
					const confidenceCol =
						session.session_type === 'morning' ? 'morning_confidence' : 'evening_confidence';
					const matchedCol =
						session.session_type === 'morning' ? 'morning_matched' : 'evening_matched';
					await client.query(
						`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, ${matchedCol}, ${confidenceCol})
				 VALUES ($1, $2, $3, true, $4)
				 ON CONFLICT (person_id, session_date)
				 DO UPDATE SET ${matchedCol} = true, ${confidenceCol} = $4, updated_at = now()`,
						[personId, session.pump_id, session.session_date, localMatch?.similarity ?? null]
					);
				}

				await client.query(
					`UPDATE attendance_sessions SET status = 'review', processed_at = now(), error_reason = NULL
					 WHERE id = $1`,
					[session.id]
				);

				await client.query(`UPDATE attendance_jobs SET status = 'done' WHERE id = $1`, [job.id]);
				await client.query('COMMIT');
				break; // success — leave the retry loop
			} catch (err) {
				await client.query('ROLLBACK').catch(() => {});
				if (isSerializationConflict(err) && attempt < SERIALIZATION_RETRY_LIMIT) {
					log(
						'warn',
						{ requestId, sessionId: session.id, attempt, code: err.code },
						'serialization conflict in Area matching — retrying phase 3 (no re-extraction needed)'
					);
					continue;
				}
				throw err; // not a conflict, or retries exhausted — handled by the outer catch below
			} finally {
				client.release();
			}
		}

		if (fraudFlags.length) {
			await keepBackup(session.id, 'fraud', 'Same face found at another pump today');
		} else {
			await dropBackup(session.id);
		}

		log(
			'info',
			{
				requestId,
				sessionId: session.id,
				matched: matchedPersons.length,
				created: newPersons.length,
				fraud: fraudFlags.length
			},
			'session ready for pump review'
		);
	} catch (err) {
		const errorMessage = String(err?.message || err);
		const retrying = job.attempts < MAX_JOB_ATTEMPTS && !(err instanceof OperatorPhotoError);
		const retryInSeconds = JOB_RETRY_BASE_SECONDS * 2 ** (job.attempts - 1);
		await pool.query(
			`UPDATE attendance_jobs
			 SET status = $2, claimed_at = NULL, claimed_by = NULL, last_error = $3,
			     available_at = now() + make_interval(secs => $4)
			 WHERE id = $1`,
			[job.id, retrying ? 'queued' : 'error', errorMessage, retryInSeconds]
		);
		await pool.query(
			`UPDATE attendance_sessions SET status = $2, error_reason = $3 WHERE id = $1`,
			[job.session_id, retrying ? 'pending' : 'failed', userFacingReason(err)]
		);
		if (!retrying) await keepBackup(job.session_id, 'failed', userFacingReason(err), errorMessage);
		log(
			retrying ? 'warn' : 'error',
			{
				requestId,
				sessionId: job.session_id,
				attempt: job.attempts,
				error: errorMessage,
				...(retrying && { retryInSeconds })
			},
			retrying ? 'session processing will retry' : 'session failed'
		);
	}
}

async function loop() {
	log(
		'info',
		{ workerBatchSize: WORKER_BATCH_SIZE, maxActiveAttendanceJobs: MAX_ACTIVE_ATTENDANCE_JOBS },
		'worker started, polling attendance_jobs'
	);
	await writeHeartbeat();
	const released = await releaseOwnClaims();
	if (released > 0) log('warn', { released }, 'released jobs this worker held before it restarted');
	const sweepStuckJobs = async () => {
		try {
			const failed = await failStuckJobs();
			if (failed > 0)
				log('warn', { failed }, 'failed jobs that ran out of attempts mid-processing');
		} catch (err) {
			log('error', { error: String(err?.message || err) }, 'stuck job sweep failed');
		}
	};
	await sweepStuckJobs();
	setInterval(sweepStuckJobs, STUCK_JOB_SWEEP_SECONDS * 1000).unref();
	const heartbeatTimer = setInterval(() => {
		writeHeartbeat().catch((err) =>
			log(
				'error',
				{ workerId: WORKER_ID, error: String(err?.message || err) },
				'worker heartbeat failed'
			)
		);
	}, HEARTBEAT_INTERVAL_MS);
	heartbeatTimer.unref();
	// Periodic sweep for stale open morning sessions across ALL pumps (§2 expiry rule).
	setInterval(
		async () => {
			try {
				const expiredCount = await expireStaleMornings(pool);
				if (expiredCount > 0)
					log('info', { expiredCount }, 'periodic sweep expired stale morning sessions');
			} catch (err) {
				log('error', { error: String(err?.message || err) }, 'periodic expiry sweep failed');
			}
			try {
				const { rowCount } = await pool.query(
					`DELETE FROM system_logs WHERE logged_at < now() - make_interval(days => $1)`,
					[LOG_RETENTION_DAYS]
				);
				if (rowCount > 0) log('info', { deleted: rowCount }, 'old log lines removed');
			} catch (err) {
				log('error', { error: String(err?.message || err) }, 'log retention sweep failed');
			}
		},
		60 * 60 * 1000
	);

	// Shift end reminders by Web Push (worker/endReminders.js), checked every minute.
	setInterval(
		() =>
			sendEndReminders(pool, log, pairingWindowHours).catch((err) =>
				log('error', { error: String(err?.message || err) }, 'shift end reminder sweep failed')
			),
		Number(process.env.END_REMINDER_POLL_SECONDS || 60) * 1000
	).unref();

	// Pump GPS positions for the shift start location check (worker/gpsFeed.js).
	const pollGps = () =>
		pollPumpGps(pool, log).catch((err) =>
			log('error', { error: String(err?.message || err) }, 'pump GPS poll failed')
		);
	// Not awaited: an unreachable GPS database must not delay attendance jobs.
	pollGps();
	setInterval(pollGps, Number(process.env.PUMP_GPS_POLL_MINUTES || 5) * 60 * 1000).unref();

	while (true) {
		try {
			const jobs = await claimJobBatch(WORKER_BATCH_SIZE);
			if (jobs.length) {
				// Process the whole batch concurrently. Each job's AI-extraction call (the
				// slow part) overlaps with the others; each job's write phase also runs
				// concurrently (no blocking lock — see processJob's Phase 3), and Postgres
				// SERIALIZABLE isolation catches and retries the rare cases where two same-
				// Area writes would otherwise conflict.
				await Promise.allSettled(jobs.map((job) => processJob(job)));
			} else {
				await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
			}
		} catch (err) {
			log('error', { error: String(err?.message || err) }, 'poll loop error');
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		}
	}
}

loop();
