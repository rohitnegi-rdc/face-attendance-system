// Background worker — plans/MasterPlan.md §2/§4/Prompt A "ASYNC part".
// Polls the Postgres-backed job queue, calls the AI microservice, runs the
// Area-scoped symmetric fraud check + local match / auto-create, and writes
// attendance. Runs as its own process/container (docker-compose "worker").
import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sendFraudAlertEmail } from './mailer.js';
import { checkRecapture } from './recaptureCheck.js';

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
const FACE_MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD ?? 0.3);
const POLL_INTERVAL_MS = 1500;
const GALLERY_SIZE = 5;
const CLAIM_TIMEOUT_MINUTES = Number(process.env.JOB_CLAIM_TIMEOUT_MINUTES ?? 10);
const MAX_JOB_ATTEMPTS = Number(process.env.MAX_JOB_ATTEMPTS ?? 3);
const AI_REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 30000);
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

function isSerializationConflict(err) {
	// 40001 = serialization_failure (SSI conflict under SERIALIZABLE), 40P01 = deadlock_detected.
	return err?.code === '40001' || err?.code === '40P01';
}

function log(level, fields, message) {
	console.log(
		JSON.stringify({
			level,
			service: 'worker',
			timestamp: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
			message,
			...fields
		})
	);
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
		 SET status = 'claimed', claimed_at = now(), attempts = attempts + 1, last_error = NULL
		 FROM (
		   SELECT id
		   FROM attendance_jobs
		   WHERE attempts < $2
		     AND (
		       status = 'queued'
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
		[CLAIM_TIMEOUT_MINUTES, MAX_JOB_ATTEMPTS, requestedLimit, MAX_ACTIVE_ATTENDANCE_JOBS]
	);
	return rows;
}

function toVectorLiteral(embedding) {
	return `[${embedding.join(',')}]`;
}

async function extractFaces(photoBuffer, requestId) {
	const form = new FormData();
	form.append('file', new Blob([photoBuffer]), 'photo.jpg');
	const res = await fetch(`${AI_SERVICE_URL}/internal/face/extract`, {
		method: 'POST',
		headers: { 'x-request-id': requestId },
		body: form,
		signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS)
	});
	if (!res.ok) throw new Error(`AI service returned ${res.status}`);
	return res.json();
}

// Same precedence as src/lib/server/settings.ts: admin setting > env > default (16h).
async function pairingWindowHours(db) {
	const { rows } = await db.query(
		`SELECT value FROM app_settings WHERE key = 'evening_pairing_window_hours'`
	);
	const stored = Number(rows[0]?.value);
	if (Number.isFinite(stored) && stored > 0) return stored;
	const fromEnv = Number(process.env.EVENING_PAIRING_WINDOW_HOURS);
	return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 16;
}

async function expireStaleMornings(db) {
	const windowHours = await pairingWindowHours(db);
	const { rows } = await db.query(
		`WITH expired AS (
		   UPDATE attendance_sessions
		   SET pairing_status = 'expired'
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
		const extractStart = Date.now();
		const [extraction, recaptureCheck] = await Promise.all([
			extractFaces(photoBuffer, requestId),
			!PHOTO_SPOOF_CHECK_ENABLED
				? Promise.resolve({ status: 'disabled' })
				: session.fraud_resolution === 'marked_normal'
					? Promise.resolve({ status: 'skipped_marked_normal' })
					: checkRecapture(photoBuffer)
		]);
		const {
			faces,
			image_preprocessing: imagePreprocessing,
			normalized_photo_base64: normalizedPhotoBase64,
			whole_image_liveness: wholeImageLiveness
		} = extraction;
		if (normalizedPhotoBase64) {
			await fs.writeFile(session.photo_url, Buffer.from(normalizedPhotoBase64, 'base64'));
		}
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

		let matchedPersons, newPersons, fraudFlags;
		for (let attempt = 0; ; attempt++) {
			const client = await pool.connect();
			try {
				await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

				matchedPersons = [];
				newPersons = [];
				fraudFlags = [];

				for (const face of faces) {
					const vec = toVectorLiteral(face.embedding);

					// CROSS-PUMP CHECK — Area-scoped, symmetric for every vendor account (§2).
					// New workers (pending_review) and sessions still awaiting the pump's review count
					// too. Comparing only against active people in completed sessions let the same new
					// worker attend two pumps on day one, and made detection depend on which pump
					// finished its review first (order-dependent, which §2 forbids).
					const { rows: crossMatches } = await client.query(
						`SELECT pfv.person_id, p.pump_id, 1 - (pfv.embedding <=> $1::vector) AS similarity,
				        dpa.session_date, ats.id AS matched_session_id
					 FROM person_face_vectors pfv
					 JOIN persons p ON p.id = pfv.person_id
					 JOIN daily_person_attendance dpa ON dpa.person_id = p.id AND dpa.session_date = $2
					 JOIN attendance_sessions ats ON ats.pump_id = p.pump_id AND ats.session_date = $2
					 JOIN pumps pu2 ON pu2.id = p.pump_id
					 JOIN plants pl2 ON pl2.id = pu2.plant_id
					 WHERE pl2.area_id = $3 AND p.pump_id != $4
					   AND p.status IN ('active', 'pending_review')
					   AND ats.status IN ('completed', 'review')
				 ORDER BY similarity DESC LIMIT 1`,
						[vec, session.session_date, areaId, session.pump_id]
					);
					const crossMatch = crossMatches[0];

					if (crossMatch && crossMatch.similarity >= FACE_MATCH_THRESHOLD) {
						await client.query(
							`INSERT INTO fraud_flags (session_id, person_id, matched_at_pump_id, matched_session_id, similarity_score)
					 VALUES ($1, $2, $3, $4, $5)`,
							[
								session.id,
								crossMatch.person_id,
								crossMatch.pump_id,
								crossMatch.matched_session_id,
								crossMatch.similarity
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

					// LOCAL MATCH — best similarity across this pump's own person gallery.
					const { rows: localMatches } = await client.query(
						`SELECT pfv.person_id, 1 - (pfv.embedding <=> $1::vector) AS similarity
				 FROM person_face_vectors pfv
				 JOIN persons p ON p.id = pfv.person_id
				 WHERE p.pump_id = $2 AND p.status = 'active'
				 ORDER BY similarity DESC LIMIT 1`,
						[vec, session.pump_id]
					);
					const localMatch = localMatches[0];

					let personId;
					if (localMatch && localMatch.similarity >= FACE_MATCH_THRESHOLD) {
						personId = localMatch.person_id;
						await client.query(`UPDATE persons SET last_seen_at = now() WHERE id = $1`, [personId]);
						matchedPersons.push({ person_id: personId, similarity: localMatch.similarity });
					} else {
						const { rows: created } = await client.query(
							`INSERT INTO persons (pump_id, status, display_seq)
					 VALUES ($1, 'pending_review', (SELECT COALESCE(MAX(display_seq), 0) + 1 FROM persons WHERE pump_id = $1))
					 RETURNING id`,
							[session.pump_id]
						);
						personId = created[0].id;
						newPersons.push({ person_id: personId });
						log('info', { requestId, sessionId: session.id, personId }, 'auto-created new person');
					}

					await client.query(
						`INSERT INTO person_face_vectors (person_id, session_id, embedding, source_photo_crop_url)
				 VALUES ($1, $2, $3::vector, $4)`,
						[
							personId,
							session.id,
							vec,
							face.crop_base64 ? `data:image/jpeg;base64,${face.crop_base64}` : null
						]
					);
					await client.query(
						`INSERT INTO attendance_face_evidence
				   (session_id, person_id, face_crop_url, match_confidence, liveness_status,
				    liveness_score, liveness_quality, liveness_reason, liveness_model, liveness_inference_ms)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
				 ON CONFLICT (session_id, person_id) DO UPDATE SET
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
							face.liveness_inference_ms ?? null
						]
					);
					// Keep gallery capped at GALLERY_SIZE (drop oldest beyond it).
					await client.query(
						`DELETE FROM person_face_vectors WHERE id IN (
				   SELECT id FROM person_face_vectors WHERE person_id = $1
				   ORDER BY created_at DESC OFFSET $2
				 )`,
						[personId, GALLERY_SIZE]
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
					`UPDATE attendance_sessions SET status = 'review', processed_at = now() WHERE id = $1`,
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
		const retrying = job.attempts < MAX_JOB_ATTEMPTS;
		await pool.query(
			`UPDATE attendance_jobs
			 SET status = $2, claimed_at = NULL, last_error = $3
			 WHERE id = $1`,
			[job.id, retrying ? 'queued' : 'error', errorMessage]
		);
		await pool.query(
			`UPDATE attendance_sessions SET status = $2, error_reason = $3 WHERE id = $1`,
			[job.session_id, retrying ? 'pending' : 'failed', errorMessage]
		);
		log(
			retrying ? 'warn' : 'error',
			{ requestId, sessionId: job.session_id, attempt: job.attempts, error: errorMessage },
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
		},
		60 * 60 * 1000
	);

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
