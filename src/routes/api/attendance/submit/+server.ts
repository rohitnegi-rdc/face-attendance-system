import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '$lib/server/db';
import { todayIST } from '$lib/server/time';
import { logger } from '$lib/server/log';
import { getAttendanceSettings } from '$lib/server/settings';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const MAX_UPLOAD_BYTES = 18 * 1024 * 1024;

class SubmissionError extends Error {
	constructor(
		message: string,
		readonly status = 409
	) {
		super(message);
	}
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user || locals.user.role !== 'pump') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}
	const pumpId = locals.user.id;
	const requestId = randomUUID();

	// The pump's JWT stays valid for 7 days, so a pump disabled mid-session (by the worker, after
	// its token was already issued) must be re-checked here, not just at login.
	const pumpAccount = await pool.query('SELECT status FROM pumps WHERE id = $1', [pumpId]);
	if (pumpAccount.rows[0]?.status === 'disabled') {
		return json({ error: 'Account disabled. Contact your Plant Manager.' }, { status: 403 });
	}

	const form = await request.formData();
	const file = form.get('photo') as File | null;
	const lat = form.get('lat') ? Number(form.get('lat')) : null;
	const lng = form.get('lng') ? Number(form.get('lng')) : null;
	if (!file) return json({ error: 'photo is required' }, { status: 400 });
	if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
		return json({ error: 'Photo must be smaller than 18 MB.' }, { status: 413 });
	}
	if (file.type && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
		return json({ error: 'Upload a JPEG, PNG, or WebP photo.' }, { status: 415 });
	}

	const buffer = Buffer.from(await file.arrayBuffer());
	const photoHash = crypto.createHash('sha256').update(buffer).digest('hex');
	const client = await pool.connect();
	let photoPath: string | null = null;

	try {
		await client.query('BEGIN');
		await client.query(
			`SELECT pg_advisory_xact_lock(hashtext('attendance-submit'), hashtext($1))`,
			[pumpId]
		);
		// Checked first: a resubmitted photo is the most accurate reason to refuse, whatever
		// state today's sessions are in.
		const duplicate = await client.query(
			'SELECT 1 FROM attendance_sessions WHERE photo_hash = $1',
			[photoHash]
		);
		if (duplicate.rowCount) throw new SubmissionError('Duplicate photo - already submitted');
		const settings = await getAttendanceSettings(client);

		await client.query(
			`WITH expired AS (
		   UPDATE attendance_sessions
		   SET pairing_status = 'expired'
		   WHERE pump_id = $1
		     AND session_type = 'morning'
		     AND status = 'completed'
		     AND pairing_status = 'open'
			     AND now() - submitted_at > ($2 || ' hours')::interval
			   RETURNING id, pump_id, session_date
			 ),
			 finalized AS (
			   INSERT INTO attendance_rollup_finalizations (pump_id, session_date, session_id)
			   SELECT pump_id, session_date, id FROM expired
			   ON CONFLICT (pump_id, session_date) DO NOTHING
			   RETURNING pump_id, session_date
			 )
			 INSERT INTO person_attendance_yearly
			   (person_id, year, days_morning_only)
			 SELECT dpa.person_id, EXTRACT(YEAR FROM dpa.session_date)::int, 1
			 FROM daily_person_attendance dpa
			 JOIN finalized f
			   ON f.pump_id = dpa.pump_id AND f.session_date = dpa.session_date
			 WHERE dpa.morning_matched AND NOT dpa.evening_matched
			 ON CONFLICT (person_id, year)
			 DO UPDATE SET
			   days_morning_only = person_attendance_yearly.days_morning_only + 1,
			   last_updated = now()`,
			[pumpId, settings.evening_pairing_window_hours]
		);

		const openMorningResult = await client.query(
			`SELECT *,
			        EXTRACT(EPOCH FROM (now() - submitted_at)) / 60 AS elapsed_minutes
			 FROM attendance_sessions
			 WHERE pump_id = $1 AND session_type = 'morning' AND status = 'completed' AND pairing_status = 'open'
			 ORDER BY submitted_at DESC LIMIT 1`,
			[pumpId]
		);
		const openMorning = openMorningResult.rows[0];
		let sessionType: 'morning' | 'evening';
		let sessionDate: string;
		let pairedMorningId: string | null = null;

		if (!openMorning) {
			const today = todayIST();
			const completedToday = await client.query(
				`SELECT 1 FROM attendance_sessions
				 WHERE pump_id = $1 AND session_date = $2
				   AND session_type = 'evening' AND pairing_status = 'paired'`,
				[pumpId, today]
			);
			if (completedToday.rowCount) {
				throw new SubmissionError('Day complete: morning and evening already recorded');
			}
			// A morning for today that is not open would otherwise hit the unique index and
			// surface as a confusing "concurrent submission" error.
			const { rows: existingMorning } = await client.query(
				`SELECT status, pairing_status FROM attendance_sessions
				 WHERE pump_id = $1 AND session_date = $2 AND session_type = 'morning'`,
				[pumpId, today]
			);
			const morning = existingMorning[0];
			if (morning) {
				const messages: Record<string, string> = {
					pending: 'Your morning photo is still being processed. Wait for it to finish.',
					processing: 'Your morning photo is still being processed. Wait for it to finish.',
					review: 'Finish reviewing the morning attendance first.',
					failed: 'Morning attendance failed. Use Retry before submitting again.',
					fraud_detected: 'Morning attendance is held for admin review.'
				};
				throw new SubmissionError(
					messages[morning.status] ??
						"The evening window for today has closed. Ask admin to correct today's attendance."
				);
			}
			sessionType = 'morning';
			sessionDate = today;
		} else {
			const elapsed = Number(openMorning.elapsed_minutes);
			if (elapsed < settings.evening_min_gap_minutes) {
				const remaining = Math.ceil(settings.evening_min_gap_minutes - elapsed);
				const hours = Math.floor(remaining / 60);
				const wait = hours ? `${hours} h ${remaining % 60} min` : `${remaining} min`;
				throw new SubmissionError(`Evening attendance opens in ${wait}.`);
			}
			sessionType = 'evening';
			sessionDate = openMorning.session_date;
			pairedMorningId = openMorning.id;
		}

		await fs.mkdir(UPLOAD_DIR, { recursive: true });
		photoPath = path.join(UPLOAD_DIR, `${randomUUID()}.jpg`);
		await fs.writeFile(photoPath, buffer);

		const sessionResult = await client.query(
			`INSERT INTO attendance_sessions
			   (pump_id, session_date, session_type, status, pairing_status,
			    photo_url, photo_hash, gps_lat, gps_lng, paired_session_id)
			 VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9)
			 RETURNING id`,
			[
				pumpId,
				sessionDate,
				sessionType,
				sessionType === 'evening' ? 'paired' : 'open',
				photoPath,
				photoHash,
				lat,
				lng,
				pairedMorningId
			]
		);
		const session = sessionResult.rows[0];

		if (sessionType === 'evening' && pairedMorningId) {
			await client.query(
				`UPDATE attendance_sessions
				 SET paired_session_id = $1, pairing_status = 'paired'
				 WHERE id = $2`,
				[session.id, pairedMorningId]
			);
		}
		await client.query(`INSERT INTO attendance_jobs (session_id, request_id) VALUES ($1, $2)`, [
			session.id,
			requestId
		]);
		await client.query('COMMIT');

		logger.info(
			{ pumpId, sessionId: session.id, sessionType, sessionDate, requestId },
			'attendance session queued'
		);
		return json(
			{ session_id: session.id, status: 'pending', request_id: requestId },
			{ status: 202 }
		);
	} catch (error: any) {
		await client.query('ROLLBACK').catch(() => {});
		if (photoPath) await fs.unlink(photoPath).catch(() => {});

		if (error instanceof SubmissionError) {
			logger.warn({ pumpId, requestId, reason: error.message }, 'attendance submission rejected');
			return json({ error: error.message }, { status: error.status });
		}
		if (error?.code === '23505') {
			const message = 'Concurrent submission already recorded';
			logger.warn({ pumpId, requestId, reason: message }, 'attendance submission rejected');
			return json({ error: message }, { status: 409 });
		}
		logger.error(
			{ pumpId, requestId, error: String(error?.message || error) },
			'attendance submission failed'
		);
		return json({ error: 'Attendance submission failed' }, { status: 500 });
	} finally {
		client.release();
	}
};
