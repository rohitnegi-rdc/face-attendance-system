import type { Actions, PageServerLoad } from './$types';
import { resolve } from '$app/paths';
import type { PoolClient } from 'pg';
import { pool, query, queryOne } from '$lib/server/db';
import { error, fail } from '@sveltejs/kit';
import { todayStr, addDaysStr, dateKey, daysBetween } from '$lib/date';
import { createAttendanceReviewFlag } from '$lib/server/attendanceReview';
import { logger } from '$lib/server/log';
import {
	clearPumpAttendance,
	deleteSession,
	removePhotoFiles,
	type CleanupResult
} from '$lib/server/sessionCleanup';
import { getAttendanceSettings } from '$lib/server/settings';
import { todayIST } from '$lib/server/time';
import {
	ShiftError,
	adminEndShift,
	moveShiftDate,
	shiftStillOpen,
	splitEndIntoStart
} from '$lib/server/shiftSessions';

const PAGE_SIZES = [25, 50, 100];

function readPaging(url: URL, pagePrefix: string) {
	const requestedPage = Number(url.searchParams.get(`${pagePrefix}_page`) || '1');
	const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
	const requestedPageSize = Number(url.searchParams.get(`${pagePrefix}_page_size`) || '25');
	const pageSize = PAGE_SIZES.includes(requestedPageSize) ? requestedPageSize : 25;
	return { page, pageSize };
}

export const load: PageServerLoad = async ({ params, url }) => {
	const pump = await queryOne<any>(
		`SELECT pu.id, pu.pump_code, pu.status, pu.disabled_at, pu.disabled_reason,
		        pl.name AS plant_name, a.name AS area_name, v.name AS vendor_name, v.id AS vendor_id, a.id AS area_id
		 FROM pumps pu
		 JOIN plants pl ON pl.id = pu.plant_id
		 JOIN areas a ON a.id = pl.area_id
		 JOIN vendors v ON v.id = pu.vendor_id
		 WHERE pu.id = $1`,
		[params.id]
	);
	if (!pump) throw error(404, 'pump not found');

	const to = url.searchParams.get('to') || todayStr();
	const from = url.searchParams.get('from') || addDaysStr(to, -29);
	const days = daysBetween(from, to);

	const rosterPaging = readPaging(url, 'roster');
	const sessionPaging = readPaging(url, 'session');

	const [{ count: rosterTotal }] = await query<any>(
		`SELECT COUNT(*) AS count FROM persons WHERE pump_id = $1 AND status = 'active'`,
		[pump.id]
	);

	const roster = await query<any>(
		`SELECT p.id, p.display_seq, p.first_seen_at, p.last_seen_at,
		        COUNT(dpa.id) FILTER (
		          WHERE dpa.morning_matched AND dpa.evening_matched
		        ) AS days_present,
		        COUNT(dpa.id) FILTER (
		          WHERE dpa.morning_matched AND NOT dpa.evening_matched AND NOT ${shiftStillOpen('dpa')}
		        ) AS days_morning_only,
		        COUNT(dpa.id) FILTER (
		          WHERE NOT dpa.morning_matched AND dpa.evening_matched
		        ) AS days_evening_only
		 FROM persons p
		 LEFT JOIN daily_person_attendance dpa ON dpa.person_id = p.id
		 WHERE p.pump_id = $1 AND p.status = 'active'
		 GROUP BY p.id
		 ORDER BY p.display_seq
		 LIMIT $2 OFFSET $3`,
		[pump.id, rosterPaging.pageSize, (rosterPaging.page - 1) * rosterPaging.pageSize]
	);
	const rosterIds = roster.map((p: any) => p.id);

	// Calendar only needs rows for the roster page currently shown.
	const attendanceRows = rosterIds.length
		? await query<any>(
				`SELECT person_id, session_date, morning_matched, evening_matched
			 FROM daily_person_attendance
			 WHERE pump_id = $1 AND person_id = ANY($2) AND session_date >= $3 AND session_date <= $4`,
				[pump.id, rosterIds, from, to]
			)
		: [];
	const attendanceMap: Record<string, string> = {};
	for (const r of attendanceRows) {
		const sessionDate = dateKey(r.session_date);
		const status =
			r.morning_matched && r.evening_matched
				? 'present'
				: r.morning_matched
					? 'morning_only'
					: 'evening_only';
		attendanceMap[`${r.person_id}|${sessionDate}`] = status;
	}

	const [{ count: sessionLogTotal }] = await query<any>(
		`SELECT COUNT(*) AS count FROM attendance_sessions
		 WHERE pump_id = $1 AND session_date >= $2 AND session_date <= $3`,
		[pump.id, from, to]
	);
	const sessionLog = await query<any>(
		`SELECT id, session_date, session_type, status, pairing_status, paired_session_id,
		        closed_by, submitted_at, processed_at, error_reason, photo_url,
		        fraud_resolution, fraud_resolved_at,
		        EXISTS (
		          SELECT 1 FROM attendance_review_flags arf
		          WHERE arf.session_id = attendance_sessions.id
		            AND arf.person_id IS NULL AND arf.status = 'open'
		        ) AS group_flagged
		 FROM attendance_sessions
		 WHERE pump_id = $1 AND session_date >= $2 AND session_date <= $3
		 ORDER BY submitted_at DESC
		 LIMIT $4 OFFSET $5`,
		[pump.id, from, to, sessionPaging.pageSize, (sessionPaging.page - 1) * sessionPaging.pageSize]
	);

	const sessionIds = sessionLog.map((s: any) => s.id);
	const faceEvidence = sessionIds.length
		? await query<any>(
				`SELECT afe.session_id, afe.person_id, afe.face_crop_url, p.display_seq,
			        EXISTS (
			          SELECT 1 FROM attendance_review_flags arf
			          WHERE arf.session_id = afe.session_id
			            AND arf.person_id = afe.person_id AND arf.status = 'open'
			        ) AS flagged
			 FROM attendance_face_evidence afe
			 JOIN persons p ON p.id = afe.person_id
			 WHERE afe.session_id = ANY($1)
			 ORDER BY p.display_seq`,
				[sessionIds]
			)
		: [];
	const evidenceBySession = new Map<string, any[]>();
	for (const face of faceEvidence) {
		const people = evidenceBySession.get(face.session_id) ?? [];
		people.push({
			personId: face.person_id,
			label: `Worker ${face.display_seq}`,
			cropUrl: face.face_crop_url,
			flagged: face.flagged
		});
		evidenceBySession.set(face.session_id, people);
	}
	const sessions = sessionLog.map((session: any) => ({
		...session,
		evidence: {
			id: session.id,
			sessionType: session.session_type,
			groupPhotoUrl: session.photo_url ? resolve(`/api/attendance/photo/${session.id}`) : null,
			groupFlagged: session.group_flagged,
			people: evidenceBySession.get(session.id) ?? []
		}
	}));

	// Rejection counts are computed from the full range, not just the current session-log
	// page, so they need their own unpaginated read of the relevant fields.
	const allSessionsInRange = await query<any>(
		`SELECT session_type, pairing_status
		 FROM attendance_sessions
		 WHERE pump_id = $1 AND session_date >= $2 AND session_date <= $3`,
		[pump.id, from, to]
	);
	const rejectionCounts = {
		morningExpired: allSessionsInRange.filter(
			(s: any) => s.session_type === 'morning' && s.pairing_status === 'expired'
		).length,
		morningAwaiting: allSessionsInRange.filter(
			(s: any) => s.session_type === 'morning' && s.pairing_status === 'open'
		).length,
		morningOnly: allSessionsInRange.filter(
			(s: any) => s.session_type === 'morning' && s.pairing_status !== 'paired'
		).length
	};

	// Daily breakdown (trend chart + daily-summary table) always covers the full selected
	// range and the full roster, independent of either table's current pagination page.
	const dailyTotals = await query<any>(
		`SELECT session_date,
		   COUNT(*) FILTER (WHERE morning_matched AND evening_matched) AS present,
		   COUNT(*) FILTER (
		     WHERE morning_matched AND NOT evening_matched
		       AND NOT ${shiftStillOpen('daily_person_attendance')}
		   ) AS morning_only,
		   COUNT(*) FILTER (WHERE evening_matched AND NOT morning_matched) AS evening_only
		 FROM daily_person_attendance
		 WHERE pump_id = $1 AND session_date >= $2 AND session_date <= $3
		 GROUP BY session_date`,
		[pump.id, from, to]
	);
	const dailyTotalsMap: Record<
		string,
		{ present: number; morningOnly: number; eveningOnly: number }
	> = {};
	for (const r of dailyTotals) {
		dailyTotalsMap[dateKey(r.session_date)] = {
			present: Number(r.present),
			morningOnly: Number(r.morning_only),
			eveningOnly: Number(r.evening_only)
		};
	}
	const rosterSize = Number(rosterTotal);
	const dailyBreakdown = days.map((day: string) => {
		const t = dailyTotalsMap[day] ?? { present: 0, morningOnly: 0, eveningOnly: 0 };
		const absent = Math.max(rosterSize - t.present - t.morningOnly - t.eveningOnly, 0);
		return {
			day,
			present: t.present,
			morningOnly: t.morningOnly,
			eveningOnly: t.eveningOnly,
			absent
		};
	});

	return {
		pump,
		roster,
		rosterPagination: {
			page: rosterPaging.page,
			pageSize: rosterPaging.pageSize,
			total: Number(rosterTotal),
			totalPages: Math.max(1, Math.ceil(Number(rosterTotal) / rosterPaging.pageSize))
		},
		sessionLog: sessions,
		sessionPagination: {
			page: sessionPaging.page,
			pageSize: sessionPaging.pageSize,
			total: Number(sessionLogTotal),
			totalPages: Math.max(1, Math.ceil(Number(sessionLogTotal) / sessionPaging.pageSize))
		},
		range: { from, to },
		days,
		attendanceMap,
		rejectionCounts,
		dailyBreakdown
	};
};

export const actions: Actions = {
	reactivatePump: async ({ params }) => {
		await queryOne(
			`UPDATE pumps SET status = 'active', disabled_at = NULL, disabled_reason = NULL WHERE id = $1`,
			[params.id]
		);
		return { success: true, message: 'Pump login reactivated.' };
	},
	flagEvidence: async ({ params, request, locals }) => {
		const form = await request.formData();
		try {
			const created = await createAttendanceReviewFlag({
				sessionId: String(form.get('session_id') || ''),
				personId: String(form.get('person_id') || '') || null,
				pumpId: params.id,
				adminId: locals.user!.id,
				reason: String(form.get('reason') || ''),
				note: String(form.get('note') || '')
			});
			return {
				success: true,
				message: created
					? 'Attendance evidence flagged for review.'
					: 'This attendance evidence is already flagged.'
			};
		} catch (actionError) {
			return fail(400, {
				message: actionError instanceof Error ? actionError.message : 'Could not flag evidence.'
			});
		}
	},
	resolveFraudSession: async ({ params, request, locals }) => {
		const form = await request.formData();
		const sessionId = String(form.get('session_id') || '');
		const resolution = String(form.get('resolution') || '');
		if (!sessionId || !['marked_normal', 'confirmed_fraud'].includes(resolution)) {
			return fail(400, { message: 'Invalid fraud resolution request.' });
		}
		const session = await queryOne<any>(
			`SELECT id, status, pump_id FROM attendance_sessions WHERE id = $1 AND pump_id = $2`,
			[sessionId, params.id]
		);
		if (!session || session.status !== 'fraud_detected') {
			return fail(400, { message: 'This session is not an unresolved fraud detection.' });
		}
		const adminId = locals.user!.id;

		if (resolution === 'marked_normal') {
			await query(
				`UPDATE attendance_sessions
				 SET status = 'pending',
				     error_reason = NULL,
				     fraud_resolution = 'marked_normal',
				     fraud_resolved_by_admin_id = $2,
				     fraud_resolved_at = now(),
				     pairing_status = CASE WHEN pairing_status = 'expired' THEN 'open' ELSE pairing_status END
				 WHERE id = $1`,
				[sessionId, adminId]
			);
			await query(
				`UPDATE attendance_jobs SET status = 'queued', attempts = 0, claimed_at = NULL, last_error = NULL
				 WHERE session_id = $1`,
				[sessionId]
			);
			await query(
				`UPDATE pumps SET status = 'active', disabled_at = NULL, disabled_reason = NULL WHERE id = $1`,
				[params.id]
			);
			return { success: true, message: 'Marked normal — reprocessing and pump login restored.' };
		}

		await query(
			`UPDATE attendance_sessions
			 SET fraud_resolution = 'confirmed_fraud', fraud_resolved_by_admin_id = $2, fraud_resolved_at = now()
			 WHERE id = $1`,
			[sessionId, adminId]
		);
		return { success: true, message: 'Confirmed as fraud. Pump login stays disabled.' };
	},
	// Deletes one session (a morning also takes its paired evening) so the pump can submit that
	// slot again. Meant for test records and wrong photos; fraud flags go with it, so it is audited.
	deleteSession: async ({ params, request, locals }) => {
		const form = await request.formData();
		const sessionId = String(form.get('session_id') || '');
		return runAuditedCleanup(locals.user!.id, params.id, 'delete_session', sessionId, (client) =>
			deleteSession(client, sessionId, { cascadePairedEvening: true })
		);
	},
	// Shift fixes for operator mistakes. Each runs in one transaction with an audit row.
	// End session: close an open shift start as "start only" (no 9 h wait for admin).
	endShift: async ({ params, request, locals }) => {
		const sessionId = String((await request.formData()).get('session_id') || '');
		return runShiftFix(locals.user!.id, params.id, 'end_shift', sessionId, async (client) => {
			const result = await adminEndShift(client, params.id, sessionId);
			return { details: result, message: 'Shift ended. Workers keep start-only attendance.' };
		});
	},
	// Split: this shift end was really the next shift's start (the operator forgot to end).
	splitShift: async ({ params, request, locals }) => {
		const sessionId = String((await request.formData()).get('session_id') || '');
		return runShiftFix(locals.user!.id, params.id, 'split_shift', sessionId, async (client) => {
			const settings = await getAttendanceSettings(client);
			const result = await splitEndIntoStart(
				client,
				params.id,
				sessionId,
				settings.evening_pairing_window_hours
			);
			return {
				details: result,
				message: `Split done. The ${result.fromDate} shift is start only, and this photo is now the shift start of ${result.toDate}${result.newStartOpen ? ' (waiting for its end)' : ''}.`
			};
		});
	},
	// Move to date: the shift (start and end) and its attendance move to another day.
	moveShift: async ({ params, request, locals }) => {
		const form = await request.formData();
		const sessionId = String(form.get('session_id') || '');
		const newDate = String(form.get('new_date') || '');
		return runShiftFix(locals.user!.id, params.id, 'move_shift', sessionId, async (client) => {
			const result = await moveShiftDate(client, params.id, sessionId, newDate, todayIST());
			return {
				details: result,
				message: `Shift moved from ${result.fromDate} to ${result.toDate}.`
			};
		});
	},
	// Wipes every attendance record of this pump. The admin must type the pump code to confirm.
	clearPumpData: async ({ params, request, locals }) => {
		const form = await request.formData();
		const pump = await queryOne<{ pump_code: string }>(
			'SELECT pump_code FROM pumps WHERE id = $1',
			[params.id]
		);
		if (!pump) return fail(404, { message: 'Pump not found.' });
		if (String(form.get('confirm_code') || '').trim() !== pump.pump_code) {
			return fail(400, { message: `Type ${pump.pump_code} exactly to confirm.` });
		}
		return runAuditedCleanup(
			locals.user!.id,
			params.id,
			'clear_pump_attendance',
			params.id,
			(client) => clearPumpAttendance(client, params.id)
		);
	}
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function runAuditedCleanup(
	adminId: string,
	pumpId: string,
	action: 'delete_session' | 'clear_pump_attendance',
	targetId: string,
	cleanup: (client: PoolClient) => Promise<CleanupResult>
) {
	if (!UUID_PATTERN.test(targetId)) return fail(400, { message: 'Invalid request.' });
	const client = await pool.connect();
	let result: CleanupResult;
	try {
		await client.query('BEGIN');
		if (action === 'delete_session') {
			const { rowCount } = await client.query(
				'SELECT 1 FROM attendance_sessions WHERE id = $1 AND pump_id = $2',
				[targetId, pumpId]
			);
			if (!rowCount) {
				await client.query('ROLLBACK');
				return fail(404, { message: 'Session not found for this pump.' });
			}
		}
		result = await cleanup(client);
		await client.query(
			`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
			 VALUES ($1, $2, $3, $4, $5)`,
			[
				adminId,
				action,
				action === 'delete_session' ? 'attendance_session' : 'pump',
				targetId,
				JSON.stringify({
					pump_id: pumpId,
					sessions_deleted: result.sessionIds,
					people_deleted: result.personIds.length,
					fraud_flags_deleted: result.fraudFlagsDeleted
				})
			]
		);
		await client.query('COMMIT');
	} catch (cleanupError) {
		await client.query('ROLLBACK').catch(() => {});
		logger.error(
			{ adminId, pumpId, action, targetId, error: String(cleanupError) },
			'admin attendance cleanup failed'
		);
		return fail(500, { message: 'Could not delete the attendance records. Nothing was changed.' });
	} finally {
		client.release();
	}
	await removePhotoFiles(result.photoPaths);
	logger.warn(
		{
			adminId,
			pumpId,
			action,
			sessions: result.sessionIds.length,
			people: result.personIds.length
		},
		'admin deleted attendance records'
	);
	return {
		success: true,
		message: `Deleted ${result.sessionIds.length} session(s), ${result.personIds.length} worker record(s) and ${result.fraudFlagsDeleted} fraud flag(s). The pump can submit again.`
	};
}

async function runShiftFix(
	adminId: string,
	pumpId: string,
	action: 'end_shift' | 'split_shift' | 'move_shift',
	sessionId: string,
	fix: (client: PoolClient) => Promise<{ details: object; message: string }>
) {
	if (!UUID_PATTERN.test(sessionId)) return fail(400, { message: 'Invalid request.' });
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const { details, message } = await fix(client);
		await client.query(
			`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
			 VALUES ($1, $2, 'attendance_session', $3, $4)`,
			[adminId, action, sessionId, JSON.stringify({ pump_id: pumpId, ...details })]
		);
		await client.query('COMMIT');
		logger.warn({ adminId, pumpId, action, sessionId, ...details }, 'admin shift fix');
		return { success: true, message };
	} catch (fixError) {
		await client.query('ROLLBACK').catch(() => {});
		if (fixError instanceof ShiftError) return fail(400, { message: fixError.message });
		logger.error(
			{ adminId, pumpId, action, sessionId, error: String(fixError) },
			'admin shift fix failed'
		);
		return fail(500, { message: 'Could not apply the fix. Nothing was changed.' });
	} finally {
		client.release();
	}
}
