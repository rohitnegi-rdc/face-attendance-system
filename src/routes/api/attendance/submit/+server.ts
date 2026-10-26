import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '$lib/server/db';
import { todayIST } from '$lib/server/time';
import { logger } from '$lib/server/log';
import { getAttendanceSettings, isTestModeOn } from '$lib/server/settings';
import { expireStaleStarts, shiftEndOpensMessage } from '$lib/server/shiftSessions';
import {
	checkShiftStartLocation,
	locationIssueText,
	sendLocationApprovalEmail,
	type LocationCheck
} from '$lib/server/locationCheck';
import { resolve } from '$app/paths';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const BACKUP_DIR = path.join(UPLOAD_DIR, 'reference');
const MAX_UPLOAD_BYTES = 18 * 1024 * 1024;

class SubmissionError extends Error {
	constructor(
		message: string,
		readonly status = 409
	) {
		super(message);
	}
}

export const POST: RequestHandler = async ({ request, locals, url }) => {
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
	// A photo of the pump operator alone, required with every shift photo (030_operator_photo.sql).
	const operatorFile = form.get('operator_photo') as File | null;
	const coordinate = (name: string) => {
		const value = Number(form.get(name));
		return form.get(name) && Number.isFinite(value) ? value : null;
	};
	const lat = coordinate('lat');
	const lng = coordinate('lng');
	if (!file) return json({ error: 'photo is required' }, { status: 400 });
	if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
		return json({ error: 'Photo must be smaller than 18 MB.' }, { status: 413 });
	}
	if (file.type && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
		return json({ error: 'Upload a JPEG, PNG, or WebP photo.' }, { status: 415 });
	}
	if (!operatorFile) {
		return json({ error: 'Take the operator photo too.' }, { status: 400 });
	}
	if (operatorFile.size <= 0 || operatorFile.size > MAX_UPLOAD_BYTES) {
		return json({ error: 'The operator photo must be smaller than 18 MB.' }, { status: 413 });
	}
	if (operatorFile.type && !['image/jpeg', 'image/png', 'image/webp'].includes(operatorFile.type)) {
		return json({ error: 'The operator photo must be a JPEG, PNG, or WebP.' }, { status: 415 });
	}

	const buffer = Buffer.from(await file.arrayBuffer());
	const photoHash = crypto.createHash('sha256').update(buffer).digest('hex');
	const operatorBuffer = Buffer.from(await operatorFile.arrayBuffer());
	const operatorHash = crypto.createHash('sha256').update(operatorBuffer).digest('hex');
	if (operatorHash === photoHash) {
		return json(
			{ error: 'Take a separate photo of the operator, not the group photo again.' },
			{ status: 400 }
		);
	}
	const client = await pool.connect();
	let photoPath: string | null = null;
	let backupPath: string | null = null;
	let operatorPath: string | null = null;

	try {
		await client.query('BEGIN');
		await client.query(
			`SELECT pg_advisory_xact_lock(hashtext('attendance-submit'), hashtext($1))`,
			[pumpId]
		);
		// Checked first: a resubmitted photo is the most accurate reason to refuse, whatever
		// state today's sessions are in.
		// Either photo counts: a group photo sent again as the operator photo is a duplicate too.
		const duplicate = await client.query(
			`SELECT 1 FROM attendance_sessions
			 WHERE photo_hash = ANY($1::text[]) OR operator_photo_hash = ANY($1::text[])`,
			[[photoHash, operatorHash]]
		);
		if (duplicate.rowCount) throw new SubmissionError('Duplicate photo - already submitted');
		const settings = await getAttendanceSettings(client);

		await expireStaleStarts(client, pumpId, settings.evening_pairing_window_hours);

		// One button for the operator: with no open shift the photo is a shift start (any time of
		// day); with an open shift it is the shift end, once the evening gap has passed.
		// FOR UPDATE: the worker's hourly expiry sweep does not take the pump lock above, so
		// without it a start could be expired (and counted start-only) while this photo pairs it.
		const openStartResult = await client.query(
			`SELECT *, session_date::text AS session_date_text,
			        EXTRACT(EPOCH FROM (now() - submitted_at)) / 60 AS elapsed_minutes
			 FROM attendance_sessions
			 WHERE pump_id = $1 AND session_type = 'morning' AND pairing_status = 'open'
			 ORDER BY submitted_at DESC LIMIT 1
			 FOR UPDATE`,
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
				throw new SubmissionError(shiftEndOpensMessage(settings.evening_min_gap_minutes - elapsed));
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

		// Shift starts in areas with the location check: compare the phone with the pump's GPS.
		const location: LocationCheck | null =
			sessionType === 'morning' ? await checkShiftStartLocation(client, pumpId, lat, lng) : null;

		await fs.mkdir(UPLOAD_DIR, { recursive: true });
		photoPath = path.join(UPLOAD_DIR, `${randomUUID()}.jpg`);
		await fs.writeFile(photoPath, buffer);
		// Untouched copy for when processing fails (db/migrations/025_photo_backups.sql).
		await fs.mkdir(BACKUP_DIR, { recursive: true });
		backupPath = path.join(BACKUP_DIR, path.basename(photoPath));
		await fs.writeFile(backupPath, buffer);
		// The worker never rewrites the operator photo, so it needs no separate backup copy.
		operatorPath = path.join(UPLOAD_DIR, `${randomUUID()}-operator.jpg`);
		await fs.writeFile(operatorPath, operatorBuffer);

		const sessionResult = await client.query(
			`INSERT INTO attendance_sessions
			   (pump_id, session_date, session_type, status, pairing_status,
			    photo_url, photo_hash, gps_lat, gps_lng, paired_session_id,
			    location_status, location_issue, location_distance_m,
			    pump_gps_lat, pump_gps_lng, pump_gps_at, operator_photo_url, operator_photo_hash,
			    test_mode)
			 VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
			         $16, $17, $18)
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
				pairedMorningId,
				location?.status ?? null,
				location?.issue ?? null,
				location?.distanceM ?? null,
				location?.pumpLat ?? null,
				location?.pumpLng ?? null,
				location?.pumpAt ?? null,
				operatorPath,
				operatorHash,
				await isTestModeOn(client)
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
		await client.query(
			`INSERT INTO attendance_photo_backups
			   (session_id, pump_id, session_date, session_type, file_path, photo_hash)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			[session.id, pumpId, sessionDate, sessionType, backupPath, photoHash]
		);
		await client.query(`INSERT INTO attendance_jobs (session_id, request_id) VALUES ($1, $2)`, [
			session.id,
			requestId
		]);
		await client.query('COMMIT');

		logger.info(
			{
				pumpId,
				sessionId: session.id,
				sessionType,
				sessionDate,
				requestId,
				location: location?.issue
			},
			'attendance session queued'
		);
		if (location?.status === 'pending') {
			void sendLocationApprovalEmail(
				session.id,
				// resolve() is relative on the server ("../../plant-manager/..."); anchor it to this URL.
				new URL(resolve('/plant-manager/approvals/[id]', { id: session.id }), url).href
			);
		}
		return json(
			{
				session_id: session.id,
				status: 'pending',
				request_id: requestId,
				location_hold:
					location?.status === 'pending'
						? locationIssueText(location.issue, location.distanceM, location.pumpAt)
						: null
			},
			{ status: 202 }
		);
	} catch (error: any) {
		await client.query('ROLLBACK').catch(() => {});
		if (photoPath) await fs.unlink(photoPath).catch(() => {});
		if (backupPath) await fs.unlink(backupPath).catch(() => {});
		if (operatorPath) await fs.unlink(operatorPath).catch(() => {});

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
