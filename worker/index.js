// Background worker — plans/MasterPlan.md §2/§4/Prompt A "ASYNC part".
// Polls the Postgres-backed job queue, calls the AI microservice, runs the
// Area-scoped symmetric fraud check + local match / auto-create, and writes
// attendance. Runs as its own process/container (docker-compose "worker").
import pg from 'pg';
import fs from 'node:fs/promises';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://ai-service:8000';
const FACE_MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD ?? 0.68);
const POLL_INTERVAL_MS = 1500;
const GALLERY_SIZE = 5;
const CLAIM_TIMEOUT_MINUTES = Number(process.env.JOB_CLAIM_TIMEOUT_MINUTES ?? 10);
const MAX_JOB_ATTEMPTS = Number(process.env.MAX_JOB_ATTEMPTS ?? 3);

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

async function claimNextJob() {
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
		   LIMIT 1
		   FOR UPDATE SKIP LOCKED
		 ) AS candidate
		 WHERE job.id = candidate.id
		 RETURNING job.*`,
		[CLAIM_TIMEOUT_MINUTES, MAX_JOB_ATTEMPTS]
	);
	return rows[0] || null;
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
		body: form
	});
	if (!res.ok) throw new Error(`AI service returned ${res.status}`);
	return res.json();
}

async function expireStaleMornings(db) {
	const windowHours = Number(process.env.EVENING_PAIRING_WINDOW_HOURS ?? 24);
	const { rows } = await db.query(
		`WITH expired AS (
		   UPDATE attendance_sessions
		   SET pairing_status = 'expired'
		   WHERE session_type = 'morning'
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
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const { rows: sessRows } = await client.query(
			'SELECT * FROM attendance_sessions WHERE id = $1',
			[job.session_id]
		);
		const session = sessRows[0];
		if (!session) throw new Error('session not found');

		const { rows: pumpRows } = await client.query(
			`SELECT pu.*, pl.area_id FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id WHERE pu.id = $1`,
			[session.pump_id]
		);
		const pump = pumpRows[0];
		const areaId = pump.area_id;

		// Advisory lock keyed on the Area — serializes concurrent matching within one Area.
		const lockStart = Date.now();
		await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [areaId]);
		const lockWaitMs = Date.now() - lockStart;

		await client.query(`UPDATE attendance_sessions SET status = 'processing' WHERE id = $1`, [
			session.id
		]);

		const photoBuffer = await fs.readFile(session.photo_url);
		const extractStart = Date.now();
		const { faces } = await extractFaces(photoBuffer, requestId);
		const extractMs = Date.now() - extractStart;

		log(
			'info',
			{
				requestId,
				sessionId: session.id,
				areaId,
				lockWaitMs,
				extractMs,
				facesDetected: faces.length
			},
			'ai extraction complete'
		);

		const matchedPersons = [];
		const newPersons = [];
		const fraudFlags = [];

		for (const face of faces) {
			const vec = toVectorLiteral(face.embedding);

			// CROSS-PUMP CHECK — Area-scoped, symmetric for every vendor account (§2).
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
					 VALUES ($1, 'active', (SELECT COALESCE(MAX(display_seq), 0) + 1 FROM persons WHERE pump_id = $1))
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
			const matchedCol = session.session_type === 'morning' ? 'morning_matched' : 'evening_matched';
			await client.query(
				`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, ${matchedCol}, ${confidenceCol})
				 VALUES ($1, $2, $3, true, $4)
				 ON CONFLICT (person_id, session_date)
				 DO UPDATE SET ${matchedCol} = true, ${confidenceCol} = $4, updated_at = now()`,
				[personId, session.pump_id, session.session_date, localMatch?.similarity ?? null]
			);
		}

		await client.query(
			`UPDATE attendance_sessions SET status = 'completed', processed_at = now() WHERE id = $1`,
			[session.id]
		);

		if (session.session_type === 'evening') {
			const { rows: finalized } = await client.query(
				`INSERT INTO attendance_rollup_finalizations (pump_id, session_date, session_id)
				 VALUES ($1, $2, $3)
				 ON CONFLICT (pump_id, session_date) DO NOTHING
				 RETURNING session_id`,
				[session.pump_id, session.session_date, session.id]
			);
			if (finalized.length) {
				const { rows: touched } = await client.query(
					`SELECT person_id, morning_matched, evening_matched FROM daily_person_attendance
					 WHERE pump_id = $1 AND session_date = $2`,
					[session.pump_id, session.session_date]
				);
				const year = new Date(session.session_date).getFullYear();
				for (const row of touched) {
					let col;
					if (row.morning_matched && row.evening_matched) col = 'days_present';
					else if (row.morning_matched) col = 'days_morning_only';
					else col = 'days_evening_only';
					await client.query(
						`INSERT INTO person_attendance_yearly (person_id, year, ${col})
						 VALUES ($1, $2, 1)
						 ON CONFLICT (person_id, year)
						 DO UPDATE SET ${col} = person_attendance_yearly.${col} + 1, last_updated = now()`,
						[row.person_id, year]
					);
				}
			}
		}

		await client.query(`UPDATE attendance_jobs SET status = 'done' WHERE id = $1`, [job.id]);
		await client.query('COMMIT');

		log(
			'info',
			{
				requestId,
				sessionId: session.id,
				matched: matchedPersons.length,
				created: newPersons.length,
				fraud: fraudFlags.length
			},
			'session completed'
		);
	} catch (err) {
		await client.query('ROLLBACK').catch(() => {});
		const errorMessage = String(err?.message || err);
		const retrying = job.attempts < MAX_JOB_ATTEMPTS;
		await client.query('BEGIN');
		await client.query(
			`UPDATE attendance_jobs
			 SET status = $2, claimed_at = NULL, last_error = $3
			 WHERE id = $1`,
			[job.id, retrying ? 'queued' : 'error', errorMessage]
		);
		await client.query(
			`UPDATE attendance_sessions SET status = $2, error_reason = $3 WHERE id = $1`,
			[job.session_id, retrying ? 'pending' : 'failed', errorMessage]
		);
		await client.query('COMMIT');
		log(
			retrying ? 'warn' : 'error',
			{ requestId, sessionId: job.session_id, attempt: job.attempts, error: errorMessage },
			retrying ? 'session processing will retry' : 'session failed'
		);
	} finally {
		client.release();
	}
}

async function loop() {
	log('info', {}, 'worker started, polling attendance_jobs');
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
			const job = await claimNextJob();
			if (job) {
				await processJob(job);
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
