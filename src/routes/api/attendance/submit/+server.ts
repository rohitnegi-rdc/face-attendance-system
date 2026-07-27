import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { query, queryOne } from '$lib/server/db';
import { todayIST, hoursSince } from '$lib/server/time';
import { logger } from '$lib/server/log';
import { randomUUID } from 'node:crypto';

const NINE_HOURS = 9;
const EVENING_PAIRING_WINDOW_HOURS = Number(process.env.EVENING_PAIRING_WINDOW_HOURS ?? 24);
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user || locals.user.role !== 'pump') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}
	const pumpId = locals.user.id;

	const form = await request.formData();
	const file = form.get('photo') as File | null;
	const lat = form.get('lat') ? Number(form.get('lat')) : null;
	const lng = form.get('lng') ? Number(form.get('lng')) : null;

	if (!file) {
		return json({ error: 'photo is required' }, { status: 400 });
	}

	const buf = Buffer.from(await file.arrayBuffer());
	const photoHash = crypto.createHash('sha256').update(buf).digest('hex');

	// Step a: lazily expire stale open morning sessions for this pump (§2 expiry-window rule).
	await query(
		`UPDATE attendance_sessions
		 SET pairing_status = 'expired'
		 WHERE pump_id = $1 AND session_type = 'morning' AND pairing_status = 'open'
		   AND now() - submitted_at > ($2 || ' hours')::interval`,
		[pumpId, EVENING_PAIRING_WINDOW_HOURS]
	);

	// Step c: determine session type from the most recent still-open morning session.
	const openMorning = await queryOne<any>(
		`SELECT * FROM attendance_sessions
		 WHERE pump_id = $1 AND session_type = 'morning' AND pairing_status = 'open'
		 ORDER BY submitted_at DESC LIMIT 1`,
		[pumpId]
	);

	let sessionType: 'morning' | 'evening';
	let sessionDate: string;
	let pairedMorningId: string | null = null;

	if (!openMorning) {
		// Check if today is already fully complete (both sessions exist and paired).
		const today = todayIST();
		const completedToday = await queryOne<any>(
			`SELECT 1 FROM attendance_sessions
			 WHERE pump_id = $1 AND session_date = $2 AND session_type = 'evening' AND pairing_status = 'paired'`,
			[pumpId, today]
		);
		if (completedToday) {
			return json({ error: 'Day complete: morning and evening already recorded' }, { status: 409 });
		}
		sessionType = 'morning';
		sessionDate = today;
	} else {
		const elapsed = hoursSince(openMorning.submitted_at);
		if (elapsed < NINE_HOURS) {
			const remaining = (NINE_HOURS - elapsed).toFixed(1);
			return json(
				{ error: `9-hour rule: ${remaining} hours remaining before evening submission is allowed` },
				{ status: 409 }
			);
		}
		sessionType = 'evening';
		sessionDate = openMorning.session_date;
		pairedMorningId = openMorning.id;
	}

	// Step d: idempotency — reject duplicate photo hash.
	const dup = await queryOne('SELECT 1 FROM attendance_sessions WHERE photo_hash = $1', [photoHash]);
	if (dup) {
		return json({ error: 'Duplicate photo — already submitted' }, { status: 409 });
	}

	// Store the photo.
	await fs.mkdir(UPLOAD_DIR, { recursive: true });
	const filename = `${randomUUID()}.jpg`;
	const photoPath = path.join(UPLOAD_DIR, filename);
	await fs.writeFile(photoPath, buf);

	// Step e: insert the session row.
	const session = await queryOne<any>(
		`INSERT INTO attendance_sessions
		   (pump_id, session_date, session_type, status, pairing_status, photo_url, photo_hash, gps_lat, gps_lng)
		 VALUES ($1, $2, $3, 'pending', 'open', $4, $5, $6, $7)
		 RETURNING id`,
		[pumpId, sessionDate, sessionType, photoPath, photoHash, lat, lng]
	);

	if (sessionType === 'evening' && pairedMorningId) {
		await query(`UPDATE attendance_sessions SET paired_session_id = $1, pairing_status = 'paired' WHERE id = $2`, [
			session.id,
			pairedMorningId
		]);
		await query(`UPDATE attendance_sessions SET paired_session_id = $1, pairing_status = 'paired' WHERE id = $2`, [
			pairedMorningId,
			session.id
		]);
	}

	const requestId = randomUUID();
	await query(`INSERT INTO attendance_jobs (session_id, request_id) VALUES ($1, $2)`, [session.id, requestId]);

	logger.info({ pumpId, sessionId: session.id, sessionType, sessionDate, requestId }, 'attendance session queued');

	return json({ session_id: session.id, status: 'pending' }, { status: 202 });
};
