import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '$lib/server/db';
import { todayIST } from '$lib/server/time';
import { logger } from '$lib/server/log';
import { getAttendanceSettings } from '$lib/server/settings';
import { expireStaleStarts, shiftEndOpensMessage } from '$lib/server/shiftSessions';

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

		await expireStaleStarts(client, pumpId, settings.evening_pairing_window_hours);

		// One button for the operator: with no open shift the photo is a shift start (any time of
		// day); with an open shift it is the shift end, once the evening gap has passed.
		const openStartResult = await client.query(
			`SELECT *, session_date::text AS session_date_text,
			        EXTRACT(EPOCH FROM (now() - submitted_at)) / 60 AS elapsed_minutes
			 FROM attendance_sessions
			 WHERE pump_id = $1 AND session_type = 'morning' AND pairing_status = 'open'
			 ORDER BY submitted_at DESC LIMIT 1`,
			[pumpId]
		);
		const openStart = openStartResult.rows[0];
		let sessionType: 'morning' | 'evening';
		let sessionDate: string;
		let pairedMorningId: string | null = null;

		if (openStart) {
			const waiting: Record<string, string> = {
				pending: 'Your shift start photo is still being processed. Wait for it to finish.',
				processing: 'Your shift start photo is still being processed. Wait for it to finish.',
				review: 'Finish reviewing the shift start photo first.',
				failed: 'The shift start photo failed. Use Retry before submitting again.'
			};
			if (openStart.status !== 'completed') {
				throw new SubmissionError(
					waiting[openStart.status] ?? 'The shift start is held for admin review.'
				);
			}
			const elapsed = Number(openStart.elapsed_minutes);
			if (elapsed < settings.evening_min_gap_minutes) {
				throw new SubmissionError(
					shiftEndOpensMessage(settings.evening_min_gap_minutes - elapsed)
				);
			}
			sessionType = 'evening';
			sessionDate = openStart.session_date_text;
			pairedMorningId = openStart.id;
		} else {
			const today = todayIST();
			// One shift per pump per date; a start for today that is closed or paired would
			// otherwise hit the unique index and surface as a confusing "concurrent submission".
			const { rows: existing } = await client.query(
				`SELECT status FROM attendance_sessions
				 WHERE pump_id = $1 AND session_date = $2 AND session_type = 'morning'`,
				[pumpId, today]
			);
			if (existing[0]) {
				throw new SubmissionError(
					existing[0].status === 'fraud_detected'
						? "Today's shift start is held for admin review."
						: "Today's shift is already recorded. The next shift can start tomorrow."
				);
			}
			sessionType = 'morning';
			sessionDate = today;
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
