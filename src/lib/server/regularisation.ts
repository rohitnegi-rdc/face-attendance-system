// Regularisation of a missed day (migration 048). A pump that was Active or Idle on a past day but
// sent no photo asks for the day to be counted: the operator on the pump screen
// (PumpRegularise.svelte), or a plant manager for them (broken or lost phone, operator away). The
// plant's business manager approves or rejects it, from the email (worker/regularisationEmail.js)
// or in the app; any admin can too, and whoever decides first settles it. An approval writes the
// ticked workers into daily_person_attendance with regularisation_id, so every count includes the
// day and every screen labels it Regularised. Nothing touches the face gallery or matching.
// Undo is admin only. Every request keeps who asked and who decided; admin actions are also in
// admin_audit_log.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { pool, query, queryOne } from './db';
import { getJwtSecret } from './auth';
import { logger } from './log';
import { mailer, mailFrom, mailEnabled } from './mail';
import { isTestModeOn } from './settings';
import { todayIST } from './time';
import { isDateKey } from '$lib/date';
import { addDays, missingDays } from '../../../worker/missingDays.js';
import { dayInfo } from './regularisationDays';
import {
	REASON_LABELS,
	WORKER_LABEL_SQL,
	buildRegularisationMessages,
	dayLabel,
	loadRegularisationFacts,
	readDecisionToken
} from '../../../worker/regularisationEmail.js';

export { REASON_LABELS, dayLabel };

export const REASONS = ['no_network', 'phone_problem', 'app_problem', 'forgot', 'other'] as const;
export type Reason = (typeof REASONS)[number];

export const REJECT_REASONS = {
	not_believable: 'The reason is not believable',
	wrong_crew: 'The workers listed are not right',
	pump_not_working: 'The pump was not working that day',
	other: 'Other'
} as const;
export type RejectReason = keyof typeof REJECT_REASONS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VOICE_MAX_BYTES = 2 * 1024 * 1024;
const voiceDir = () => path.resolve(process.env.UPLOAD_DIR || './uploads', 'regularisations');

export type Requester = { role: 'pump' | 'plant-manager' | 'admin'; id: string };
export type Viewer = Requester;
export type Decider = { role: 'business_manager' | 'admin'; id: string };

// Pumps a requester may ask for: the pump itself; a plant manager's own plants and monitored Areas
// (not plants it only approves for as business manager: the one who asks does not also approve);
// an admin any pump. $1 is the requester id; pumps alias pu.
function requestScope(role: Requester['role']) {
	if (role === 'pump') return 'pu.id = $1::uuid';
	if (role === 'admin') return '$1::uuid IS NOT NULL';
	return `pu.plant_id IN (
	  SELECT plant_id FROM plant_manager_assignments WHERE manager_id = $1::uuid
	  UNION SELECT pl.id FROM monitor_areas ma JOIN plants pl ON pl.area_id = ma.area_id
	  WHERE ma.manager_id = $1::uuid)`;
}

// Pumps whose requests a login sees: a pump its own, a plant-manager login every plant on its pages
// (manager_plants: own, monitored and business-manager plants), an admin all. $1 the login id.
function viewScope(role: Viewer['role']) {
	if (role === 'pump') return 'pu.id = $1::uuid';
	if (role === 'admin') return '$1::uuid IS NOT NULL';
	return 'pu.plant_id IN (SELECT plant_id FROM manager_plants WHERE manager_id = $1::uuid)';
}

export type RequestablePump = {
	id: string;
	code: string;
	plantName: string;
	missed: number;
	latestMissed: string | null;
};

// The pumps a login can apply for, those with missed days first (most recent first).
export async function listRequestablePumps(actor: Requester): Promise<RequestablePump[]> {
	const pumps = await query<{ id: string; pump_code: string; plant_name: string }>(
		`SELECT pu.id, pu.pump_code, pl.name AS plant_name
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id
		 WHERE ${requestScope(actor.role)} ORDER BY pl.name, pu.pump_code`,
		[actor.id]
	);
	const rows: MissingRow[] = await missingDays(
		pool,
		pumps.map((p) => p.id),
		{ today: todayIST() }
	);
	const latest = new Map<string, { missed: number; latest: string }>();
	for (const row of rows) {
		const seen = latest.get(row.pump_id);
		if (seen) seen.missed += 1;
		else latest.set(row.pump_id, { missed: 1, latest: row.day });
	}
	return pumps
		.map((p) => ({
			id: p.id,
			code: p.pump_code,
			plantName: p.plant_name,
			missed: latest.get(p.id)?.missed ?? 0,
			latestMissed: latest.get(p.id)?.latest ?? null
		}))
		.sort((a, b) => (b.latestMissed ?? '').localeCompare(a.latestMissed ?? ''));
}

export type MissingDay = {
	pumpId: string;
	pumpCode: string;
	plantName: string;
	areaName: string;
	day: string;
	status: 'active' | 'idle';
};

type MissingRow = { pump_id: string; day: string; status: 'active' | 'idle' };

// Missed days of the pumps a requester may ask for, most recent first.
export async function listMissingDays(actor: Requester, limit = 200): Promise<MissingDay[]> {
	const pumps = await query<{
		id: string;
		pump_code: string;
		plant_name: string;
		area_name: string;
	}>(
		`SELECT pu.id, pu.pump_code, pl.name AS plant_name, a.name AS area_name
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		 WHERE ${requestScope(actor.role)}`,
		[actor.id]
	);
	const byId = new Map(pumps.map((p) => [p.id, p]));
	const rows: MissingRow[] = await missingDays(pool, [...byId.keys()], { today: todayIST() });
	return rows.slice(0, limit).map((r) => {
		const pump = byId.get(r.pump_id)!;
		return {
			pumpId: r.pump_id,
			pumpCode: pump.pump_code,
			plantName: pump.plant_name,
			areaName: pump.area_name,
			day: r.day,
			status: r.status
		};
	});
}

export type CrewMember = {
	personId: string;
	label: string;
	ticked: boolean;
	// On a half-counted day, the half the worker already has.
	half: 'start' | 'end' | null;
};
export type Crew = { kind: 'missed' | 'partial'; crew: CrewMember[] };

type CrewRow = {
	id: string;
	name: string | null;
	display_seq: number;
	ticked: boolean;
	half: 'start' | 'end' | null;
};

// A real photo attendance at this pump: a day counted from a photo. A whole day added by a
// regularisation does not count; a day where one real half was completed does. $1 is the pump.
const HAS_REAL_ATTENDANCE = `EXISTS (
	SELECT 1 FROM daily_person_attendance real
	WHERE real.person_id = p.id AND real.pump_id = $1
	  AND (real.morning_matched OR real.evening_matched)
	  AND (real.regularisation_id IS NULL OR EXISTS (
	    SELECT 1 FROM regularisation_workers added
	    WHERE added.regularisation_id = real.regularisation_id
	      AND added.person_id = real.person_id AND added.adds IS NOT NULL)))`;

// Who can be selected for a day that can be applied for. A half-counted day: only the workers
// missing a half, all ticked. A day with no photo: every current worker with a real attendance
// here, the crew of the nearest full shift (before the day first) ticked.
export async function crewFor(
	pumpId: string,
	day: string,
	kind: Crew['kind'],
	db: Pool | PoolClient = pool
): Promise<Crew> {
	const { rows } = await db.query<CrewRow>(
		kind === 'partial'
			? `SELECT p.id, p.name, p.display_seq, true AS ticked,
			          CASE WHEN a.morning_matched THEN 'start' ELSE 'end' END AS half
			   FROM daily_person_attendance a JOIN persons p ON p.id = a.person_id
			   WHERE a.pump_id = $1 AND a.session_date = $2::date
			     AND a.morning_matched <> a.evening_matched
			     AND p.status IN ('active', 'pending_review')
			   ORDER BY p.display_seq`
			: `WITH nearest AS (
			     SELECT dpa.session_date FROM daily_person_attendance dpa
			     WHERE dpa.pump_id = $1 AND dpa.morning_matched AND dpa.evening_matched
			       AND dpa.regularisation_id IS NULL
			     ORDER BY (dpa.session_date > $2::date), abs(dpa.session_date - $2::date)
			     LIMIT 1
			   )
			   SELECT p.id, p.name, p.display_seq, NULL AS half,
			          EXISTS (SELECT 1 FROM daily_person_attendance d, nearest n
			                  WHERE d.person_id = p.id AND d.session_date = n.session_date
			                    AND d.morning_matched AND d.evening_matched) AS ticked
			   FROM persons p
			   WHERE p.pump_id = $1 AND p.status IN ('active', 'pending_review')
			     AND ${HAS_REAL_ATTENDANCE}
			   ORDER BY ticked DESC, p.display_seq`,
		[pumpId, day]
	);
	// No full shift yet to go by: everyone starts ticked, and the operator unticks who was absent.
	const none = !rows.some((r) => r.ticked);
	return {
		kind,
		crew: rows.map((r) => ({
			personId: r.id,
			label: r.name?.trim() || `Worker ${r.display_seq}`,
			ticked: none || r.ticked,
			half: r.half
		}))
	};
}

export type RequestInput = {
	pumpId: string;
	day: string;
	reason: string;
	note?: string | null;
	workers: string[];
	voice?: { bytes: Uint8Array; type: string } | null;
};

type Failure = { ok: false; status: number; error: string };
type Result<T = object> = ({ ok: true } & T) | Failure;
const fail = (status: number, error: string): Failure => ({ ok: false, status, error });

async function requesterName(actor: Requester) {
	if (actor.role === 'pump') {
		const row = await queryOne<{ pump_code: string }>('SELECT pump_code FROM pumps WHERE id = $1', [
			actor.id
		]);
		return row ? `${row.pump_code} operator` : 'Pump operator';
	}
	const row =
		actor.role === 'admin'
			? await queryOne<{ name: string }>('SELECT email AS name FROM admins WHERE id = $1', [
					actor.id
				])
			: await queryOne<{ name: string }>('SELECT name FROM plant_managers WHERE id = $1', [
					actor.id
				]);
	return row?.name ?? actor.role;
}

function voiceExtension(type: string) {
	if (!type.startsWith('audio/')) return null;
	if (type.includes('webm')) return 'webm';
	if (type.includes('ogg')) return 'ogg';
	if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
	if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
	if (type.includes('wav')) return 'wav';
	return null;
}

async function audit(
	client: PoolClient,
	adminId: string,
	action: string,
	id: string,
	details: object
) {
	await client.query(
		`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
		 VALUES ($1, $2, 'regularisation', $3, $4)`,
		[adminId, action, id, JSON.stringify(details)]
	);
}

// Asks for a missed day. An admin's request is approved at once (they would approve it anyway),
// and audited; anyone else's waits for the business manager (or the admins) and emails them.
export async function createRequest(
	actor: Requester,
	input: RequestInput,
	linkBase: string
): Promise<Result<{ id: string; status: 'pending' | 'approved' }>> {
	const { pumpId, day } = input;
	if (!UUID.test(pumpId) || !isDateKey(day)) return fail(400, 'Choose a pump and a day');
	if (day >= todayIST()) return fail(400, 'Only a past day can be regularised');
	if (!(REASONS as readonly string[]).includes(input.reason)) {
		return fail(400, 'Choose why no photo was taken');
	}
	const note = input.note?.trim() || null;
	if (note && note.length > 500) return fail(400, 'Keep the note under 500 letters');
	if (input.reason === 'other' && !note && !input.voice) {
		return fail(400, 'Say or write what happened');
	}
	const workers = [...new Set(input.workers.filter((w) => UUID.test(w)))];
	if (workers.length === 0) return fail(400, 'Tick at least one worker');
	let voiceExt: string | null = null;
	if (input.voice) {
		voiceExt = voiceExtension(input.voice.type);
		if (!voiceExt) return fail(400, 'The voice note is not a sound recording');
		if (input.voice.bytes.byteLength > VOICE_MAX_BYTES)
			return fail(400, 'The voice note is too long');
	}

	const pump = await queryOne<{ id: string }>(
		`SELECT pu.id FROM pumps pu WHERE pu.id = $2 AND ${requestScope(actor.role)}`,
		[actor.id, pumpId]
	);
	if (!pump) return fail(404, 'Pump not found');
	const name = await requesterName(actor);
	const id = randomUUID();
	let voicePath: string | null = null;

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const info = await dayInfo(client, pumpId, day);
		if (!info.canApply || !info.kind) {
			await client.query('ROLLBACK');
			return fail(
				409,
				'This day cannot be regularised: it is complete, already asked for, or the pump was Inactive'
			);
		}
		const { crew } = await crewFor(pumpId, day, info.kind, client);
		const allowed = new Map(crew.map((c) => [c.personId, c]));
		if (!workers.every((w) => allowed.has(w))) {
			await client.query('ROLLBACK');
			return fail(400, 'A ticked worker cannot be counted for this day');
		}
		// The half each worker is missing; NULL adds the whole day.
		const adds = workers.map((w) => {
			const half = allowed.get(w)!.half;
			return half === 'start' ? 'end' : half === 'end' ? 'start' : null;
		});
		if (input.voice && voiceExt) {
			await fs.mkdir(voiceDir(), { recursive: true });
			voicePath = path.join(voiceDir(), `${id}.${voiceExt}`);
			await fs.writeFile(voicePath, input.voice.bytes);
		}
		const role = actor.role === 'plant-manager' ? 'plant_manager' : actor.role;
		await client.query(
			`INSERT INTO regularisations (id, pump_id, day, reason, note, voice_path, voice_type,
			   requested_by_role, requested_by_id, requested_by_name, link_base)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
			[
				id,
				pumpId,
				day,
				input.reason,
				note,
				voicePath,
				input.voice?.type ?? null,
				role,
				actor.id,
				name,
				linkBase
			]
		);
		await client.query(
			`INSERT INTO regularisation_workers (regularisation_id, person_id, adds)
			 SELECT $1, w.person, w.adds FROM unnest($2::uuid[], $3::text[]) AS w(person, adds)`,
			[id, workers, adds]
		);
		if (actor.role === 'admin') {
			await approveInside(client, id, { role: 'admin', id: actor.id }, name);
			await audit(client, actor.id, 'regularisation_created_approved', id, {
				pumpId,
				day,
				workers: workers.length
			});
		}
		await client.query('COMMIT');
	} catch (err) {
		await client.query('ROLLBACK').catch(() => {});
		if (voicePath) await fs.rm(voicePath, { force: true }).catch(() => {});
		if ((err as { code?: string }).code === '23505')
			return fail(409, 'This day is already asked for');
		throw err;
	} finally {
		client.release();
	}
	logger.info({ regularisationId: id, pumpId, day, by: actor.role }, 'regularisation requested');
	if (actor.role !== 'admin') await sendRequestEmail(id);
	return { ok: true, id, status: actor.role === 'admin' ? 'approved' : 'pending' };
}

async function deciderName(decider: Decider) {
	if (decider.role === 'admin') {
		const row = await queryOne<{ email: string }>('SELECT email FROM admins WHERE id = $1', [
			decider.id
		]);
		return row?.email ?? null;
	}
	const row = await queryOne<{ name: string }>(
		`SELECT name FROM plant_managers WHERE id = $1 AND is_business_manager AND disabled_at IS NULL`,
		[decider.id]
	);
	return row?.name ?? null;
}

async function approveInside(client: PoolClient, id: string, decider: Decider, name: string) {
	const { rows } = await client.query(
		`UPDATE regularisations SET status = 'approved', decided_by_role = $2, decided_by_id = $3,
		   decided_by_name = $4, decided_at = now()
		 WHERE id = $1 RETURNING pump_id, to_char(day, 'YYYY-MM-DD') AS day`,
		[id, decider.role, decider.id, name]
	);
	const { pump_id: pumpId, day } = rows[0];
	const whole = await client.query(
		`INSERT INTO daily_person_attendance
		   (person_id, pump_id, session_date, morning_matched, evening_matched, regularisation_id, updated_at)
		 SELECT rw.person_id, $2, $3, true, true, $1, now()
		 FROM regularisation_workers rw JOIN persons p ON p.id = rw.person_id
		 WHERE rw.regularisation_id = $1 AND rw.adds IS NULL AND p.status IN ('active', 'pending_review')
		 ON CONFLICT (person_id, session_date) DO NOTHING`,
		[id, pumpId, day]
	);
	// A half: only while it is still missing. A photo may have filled it since the request.
	const halves = await client.query(
		`UPDATE daily_person_attendance d
		 SET morning_matched = true, evening_matched = true, regularisation_id = $1, updated_at = now()
		 FROM regularisation_workers rw, persons p
		 WHERE rw.regularisation_id = $1 AND rw.person_id = d.person_id AND p.id = d.person_id
		   AND p.status IN ('active', 'pending_review')
		   AND d.pump_id = $2 AND d.session_date = $3 AND d.regularisation_id IS NULL
		   AND ((rw.adds = 'end' AND d.morning_matched AND NOT d.evening_matched)
		     OR (rw.adds = 'start' AND d.evening_matched AND NOT d.morning_matched))`,
		[id, pumpId, day]
	);
	return (whole.rowCount ?? 0) + (halves.rowCount ?? 0);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Thu, 22 Oct 2026, 11:16 am" in India time, computed in code.
export function humanTime(value: Date | string) {
	const d = new Date(new Date(value).getTime() + 330 * 60 * 1000);
	const h = d.getUTCHours();
	const minutes = String(d.getUTCMinutes()).padStart(2, '0');
	return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h % 12 || 12}:${minutes} ${h < 12 ? 'am' : 'pm'}`;
}

const STATUS_WORD: Record<string, string> = {
	approved: 'approved',
	rejected: 'rejected',
	cancelled: 'withdrawn',
	undone: 'undone'
};

function settledMessage(row: {
	status: string;
	decided_by_name: string | null;
	decided_at: Date | null;
}) {
	const by = row.decided_by_name ? ` by ${row.decided_by_name}` : '';
	const when = row.decided_at ? ` on ${humanTime(row.decided_at)}` : '';
	return `Already ${STATUS_WORD[row.status] ?? row.status}${by}${when}.`;
}

export type DecisionInput = {
	approve: boolean;
	rejectReason?: string | null;
	note?: string | null;
};

// Approves or rejects a waiting request. A business manager only for the plants it holds now.
export async function decide(decider: Decider, id: string, input: DecisionInput): Promise<Result> {
	if (!UUID.test(id)) return fail(404, 'Request not found');
	const note = input.note?.trim() || null;
	if (!input.approve) {
		if (!input.rejectReason || !(input.rejectReason in REJECT_REASONS)) {
			return fail(400, 'Choose why it is rejected');
		}
		if (input.rejectReason === 'other' && !note) return fail(400, 'Write why it is rejected');
		if (note && note.length > 400) return fail(400, 'Keep the note under 400 letters');
	}
	const name = await deciderName(decider);
	if (!name) return fail(403, 'You cannot decide this request');
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const { rows } = await client.query(
			`SELECT r.status, r.decided_by_name, r.decided_at, r.pump_id,
			        to_char(r.day, 'YYYY-MM-DD') AS day,
			        EXISTS (SELECT 1 FROM business_manager_plants b JOIN pumps pu ON pu.plant_id = b.plant_id
			                WHERE pu.id = r.pump_id AND b.manager_id = $2::uuid) AS owns
			 FROM regularisations r WHERE r.id = $1 FOR UPDATE`,
			[id, decider.id]
		);
		const row = rows[0];
		if (!row || (decider.role === 'business_manager' && !row.owns)) {
			await client.query('ROLLBACK');
			return fail(404, 'Request not found');
		}
		if (row.status !== 'pending') {
			await client.query('ROLLBACK');
			return fail(409, settledMessage(row));
		}
		if (input.approve) {
			// A photo or a count that arrived after a whole-day request: the day is no longer missing.
			// A half-day request already has photos; each half is checked as it is added.
			const since = await client.query(
				`SELECT 1 WHERE NOT EXISTS (
				   SELECT 1 FROM regularisation_workers WHERE regularisation_id = $3 AND adds IS NOT NULL)
				 AND (EXISTS (SELECT 1 FROM attendance_sessions
				              WHERE pump_id = $1 AND session_date = $2 AND status <> 'failed')
				   OR EXISTS (SELECT 1 FROM daily_person_attendance
				              WHERE pump_id = $1 AND session_date = $2))`,
				[row.pump_id, row.day, id]
			);
			if (since.rowCount || (await approveInside(client, id, decider, name)) === 0) {
				await client.query('ROLLBACK');
				return fail(409, 'Attendance for this day has arrived since; nothing to approve');
			}
		} else {
			const label = REJECT_REASONS[input.rejectReason as RejectReason];
			const reason = input.rejectReason === 'other' ? note : note ? `${label}: ${note}` : label;
			await client.query(
				`UPDATE regularisations SET status = 'rejected', decided_by_role = $2, decided_by_id = $3,
				   decided_by_name = $4, decided_at = now(), decision_reason = $5
				 WHERE id = $1`,
				[id, decider.role, decider.id, name, reason]
			);
		}
		if (decider.role === 'admin') {
			await audit(
				client,
				decider.id,
				input.approve ? 'regularisation_approved' : 'regularisation_rejected',
				id,
				{ pumpId: row.pump_id, day: row.day }
			);
		}
		await client.query('COMMIT');
	} catch (err) {
		await client.query('ROLLBACK').catch(() => {});
		throw err;
	} finally {
		client.release();
	}
	logger.info(
		{ regularisationId: id, by: decider.role },
		input.approve ? 'regularisation approved' : 'regularisation rejected'
	);
	return { ok: true };
}

// The one who asked (or an admin) withdraws a request still waiting.
export async function cancelRequest(actor: Requester, id: string): Promise<Result> {
	if (!UUID.test(id)) return fail(404, 'Request not found');
	const name = await requesterName(actor);
	const { rowCount } = await pool.query(
		`UPDATE regularisations r SET status = 'cancelled', decided_at = now(), decided_by_name = $3
		 FROM pumps pu WHERE pu.id = r.pump_id AND r.id = $2 AND r.status = 'pending'
		   AND ${requestScope(actor.role)}`,
		[actor.id, id, name]
	);
	return rowCount ? { ok: true } : fail(409, 'Only a waiting request can be withdrawn');
}

// Admin only: takes an approved day back out of the counts.
export async function undoRequest(adminId: string, id: string, reason: string): Promise<Result> {
	if (!UUID.test(id)) return fail(404, 'Request not found');
	const why = reason.trim();
	if (why.length < 5 || why.length > 500)
		return fail(400, 'Write why it is undone (5 to 500 letters)');
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const { rows } = await client.query(
			`UPDATE regularisations SET status = 'undone', undone_by_admin_id = $2, undone_at = now()
			 WHERE id = $1 AND status = 'approved'
			 RETURNING pump_id, to_char(day, 'YYYY-MM-DD') AS day`,
			[id, adminId]
		);
		if (!rows[0]) {
			await client.query('ROLLBACK');
			return fail(409, 'Only an approved day can be undone');
		}
		// A half-day: take back only the added half, the real photo stays. A whole day: remove it.
		const restored = await client.query(
			`UPDATE daily_person_attendance d
			 SET morning_matched = d.morning_matched AND rw.adds <> 'start',
			     evening_matched = d.evening_matched AND rw.adds <> 'end',
			     regularisation_id = NULL, updated_at = now()
			 FROM regularisation_workers rw
			 WHERE rw.regularisation_id = $1 AND rw.person_id = d.person_id
			   AND d.regularisation_id = $1 AND rw.adds IS NOT NULL`,
			[id]
		);
		const removed = await client.query(
			'DELETE FROM daily_person_attendance WHERE regularisation_id = $1',
			[id]
		);
		await audit(client, adminId, 'regularisation_undone', id, {
			...rows[0],
			reason: why,
			removed: removed.rowCount,
			restored: restored.rowCount
		});
		await client.query('COMMIT');
	} catch (err) {
		await client.query('ROLLBACK').catch(() => {});
		throw err;
	} finally {
		client.release();
	}
	logger.info({ regularisationId: id }, 'regularisation undone');
	return { ok: true };
}

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'undone';

export type RequestRow = {
	id: string;
	pumpId: string;
	pumpCode: string;
	plantName: string;
	areaName: string;
	day: string;
	reason: Reason;
	note: string | null;
	hasVoice: boolean;
	status: RequestStatus;
	requestedByRole: 'pump' | 'plant_manager' | 'admin';
	requestedByName: string;
	requestedAt: string;
	decidedByName: string | null;
	decidedAt: string | null;
	decisionReason: string | null;
	workers: string[];
	canDecide: boolean;
	canCancel: boolean;
	approverName: string | null;
};

export type ListFilter = {
	status?: 'pending' | 'decided' | 'all';
	pumpId?: string;
	decideOnly?: boolean;
	limit?: number;
};

type RequestDbRow = {
	id: string;
	pump_id: string;
	pump_code: string;
	plant_name: string;
	area_name: string;
	day: string;
	reason: Reason;
	note: string | null;
	has_voice: boolean;
	status: RequestStatus;
	requested_by_role: RequestRow['requestedByRole'];
	requested_by_id: string;
	requested_by_name: string;
	requested_at: Date;
	decided_by_name: string | null;
	decided_at: Date | null;
	decision_reason: string | null;
	bm_id: string | null;
	bm_name: string | null;
	workers: string[];
};

// Requests a login sees, waiting ones first. canDecide: an admin any waiting one, a business
// manager the waiting ones of its plants. canCancel: the one who asked, while it waits.
export async function listRequests(viewer: Viewer, filter: ListFilter = {}): Promise<RequestRow[]> {
	const where = [viewScope(viewer.role)];
	const params: unknown[] = [viewer.id];
	if (filter.status === 'pending') where.push(`r.status = 'pending'`);
	if (filter.status === 'decided') where.push(`r.status <> 'pending'`);
	if (filter.pumpId && UUID.test(filter.pumpId)) {
		params.push(filter.pumpId);
		where.push(`r.pump_id = $${params.length}`);
	}
	if (filter.decideOnly && viewer.role === 'plant-manager') where.push('bmp.manager_id = $1::uuid');
	params.push(Math.min(filter.limit ?? 200, 500));
	const rows = await query<RequestDbRow>(
		`SELECT r.id, r.pump_id, pu.pump_code, pl.name AS plant_name, a.name AS area_name,
		        to_char(r.day, 'YYYY-MM-DD') AS day, r.reason, r.note,
		        r.voice_path IS NOT NULL AS has_voice, r.status, r.requested_by_role, r.requested_by_id,
		        r.requested_by_name, r.requested_at, r.decided_by_name, r.decided_at, r.decision_reason,
		        bmp.manager_id AS bm_id, bm.name AS bm_name,
		        ARRAY(SELECT ${WORKER_LABEL_SQL}
		              FROM regularisation_workers rw JOIN persons p ON p.id = rw.person_id
		              WHERE rw.regularisation_id = r.id ORDER BY p.display_seq) AS workers
		 FROM regularisations r
		 JOIN pumps pu ON pu.id = r.pump_id JOIN plants pl ON pl.id = pu.plant_id
		 JOIN areas a ON a.id = pl.area_id
		 LEFT JOIN business_manager_plants bmp ON bmp.plant_id = pl.id
		 LEFT JOIN plant_managers bm ON bm.id = bmp.manager_id
		 WHERE ${where.join(' AND ')}
		 ORDER BY (r.status = 'pending') DESC, r.requested_at DESC
		 LIMIT $${params.length}`,
		params
	);
	return rows.map((r) => ({
		id: r.id,
		pumpId: r.pump_id,
		pumpCode: r.pump_code,
		plantName: r.plant_name,
		areaName: r.area_name,
		day: r.day,
		reason: r.reason,
		note: r.note,
		hasVoice: r.has_voice,
		status: r.status,
		requestedByRole: r.requested_by_role,
		requestedByName: r.requested_by_name,
		requestedAt: humanTime(r.requested_at),
		decidedByName: r.decided_by_name,
		decidedAt: r.decided_at ? humanTime(r.decided_at) : null,
		decisionReason: r.decision_reason,
		workers: r.workers,
		canDecide:
			r.status === 'pending' &&
			(viewer.role === 'admin' || (viewer.role === 'plant-manager' && r.bm_id === viewer.id)),
		canCancel:
			r.status === 'pending' && (viewer.role === 'admin' || r.requested_by_id === viewer.id),
		approverName: r.bm_name ?? null
	}));
}

// The voice note of a request the viewer may see; with no viewer, the caller has checked a token.
export async function voiceFile(id: string, viewer: Viewer | null) {
	if (!UUID.test(id)) return null;
	type VoiceRow = { voice_path: string | null; voice_type: string | null };
	const row = viewer
		? await queryOne<VoiceRow>(
				`SELECT r.voice_path, r.voice_type FROM regularisations r JOIN pumps pu ON pu.id = r.pump_id
				 WHERE r.id = $2 AND ${viewScope(viewer.role)}`,
				[viewer.id, id]
			)
		: await queryOne<VoiceRow>('SELECT voice_path, voice_type FROM regularisations WHERE id = $1', [
				id
			]);
	if (!row?.voice_path) return null;
	const resolved = path.resolve(row.voice_path);
	const relative = path.relative(voiceDir(), resolved);
	if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
	try {
		return { bytes: await fs.readFile(resolved), type: row.voice_type || 'audio/webm' };
	} catch {
		return null;
	}
}

export type RegularisationFacts = {
	id: string;
	pump_id: string;
	day: string;
	reason: Reason;
	note: string | null;
	has_voice: boolean;
	requested_by_role: RequestRow['requestedByRole'];
	requested_by_name: string;
	requested_at: Date;
	status: RequestStatus;
	decided_by_name: string | null;
	decided_at: Date | null;
	decision_reason: string | null;
	pump_code: string;
	plant_name: string;
	area_name: string;
	plant_manager_name: string | null;
	business_manager_id: string | null;
	business_manager_name: string | null;
	worker_count: number;
	month_count: number;
	last_photo_day: string | null;
};

// The decision link from the email: who it is for and whether they may still decide.
export async function readDecisionLink(token: string) {
	const parsed = readDecisionToken(getJwtSecret(), token);
	if (!parsed) return null;
	const facts: RegularisationFacts | null = await loadRegularisationFacts(pool, parsed.id);
	if (!facts) return null;
	const decider: Decider = {
		role: parsed.role === 'b' ? 'business_manager' : 'admin',
		id: parsed.actorId
	};
	const name = await deciderName(decider);
	const allowed =
		Boolean(name) && (decider.role === 'admin' || facts.business_manager_id === decider.id);
	const workers = await query<{ label: string }>(
		`SELECT ${WORKER_LABEL_SQL} AS label
		 FROM regularisation_workers rw JOIN persons p ON p.id = rw.person_id
		 WHERE rw.regularisation_id = $1 ORDER BY p.display_seq`,
		[parsed.id]
	);
	return { decider, deciderName: name, allowed, facts, workers: workers.map((w) => w.label) };
}

// The first email to the approver (the business manager, else every admin). Logged instead of
// sent while test mode is on or mail is off.
export async function sendRequestEmail(id: string) {
	try {
		const messages = await buildRegularisationMessages(pool, getJwtSecret(), id, 'request');
		if (messages.length === 0) {
			logger.warn(
				{ regularisationId: id },
				'regularisation email: nobody with a mailbox to send to'
			);
			return;
		}
		const testMode = await isTestModeOn();
		const client = mailer();
		for (const message of messages) {
			const fields = {
				regularisationId: id,
				kind: 'request',
				to: message.to,
				subject: message.subject,
				approveUrl: message.approveUrl,
				rejectUrl: message.rejectUrl
			};
			if (testMode) {
				logger.info(fields, 'regularisation email NOT sent (test mode)');
				continue;
			}
			if (!mailEnabled()) {
				logger.info(fields, 'regularisation email NOT sent (mail off)');
				continue;
			}
			if (!client) {
				logger.warn(fields, 'regularisation email skipped: SMTP not configured');
				continue;
			}
			await client.sendMail({
				from: mailFrom(),
				to: message.to,
				subject: message.subject,
				html: message.html,
				text: message.text
			});
			logger.info({ regularisationId: id, subject: message.subject }, 'regularisation email sent');
		}
	} catch (err) {
		logger.error(
			{ regularisationId: id, error: String((err as Error)?.message || err) },
			'regularisation email failed'
		);
	}
}

// What the pump screen needs: its missed days (most recent first), the crew for the latest one,
// and its requests of the last 30 days with their outcome.
export async function pumpRegularisationState(pumpId: string) {
	const actor: Requester = { role: 'pump', id: pumpId };
	const days = await listMissingDays(actor, 60);
	const requests = await listRequests(actor, { limit: 30 });
	const since = addDays(todayIST(), -30);
	return {
		days: days.map((d) => d.day),
		month: todayIST().slice(0, 7),
		requests: requests
			.filter((r) => r.day >= since)
			.map((r) => ({
				id: r.id,
				day: r.day,
				status: r.status,
				decisionReason: r.decisionReason,
				decidedAt: r.decidedAt
			}))
	};
}

// Requests waiting that this login can decide (the nav badge).
export async function pendingForDecider(role: 'admin' | 'plant-manager', id: string) {
	const row =
		role === 'admin'
			? await queryOne<{ n: number }>(
					`SELECT count(*)::int AS n FROM regularisations WHERE status = 'pending'`
				)
			: await queryOne<{ n: number }>(
					`SELECT count(*)::int AS n FROM regularisations r JOIN pumps pu ON pu.id = r.pump_id
					 JOIN business_manager_plants b ON b.plant_id = pu.plant_id
					 WHERE r.status = 'pending' AND b.manager_id = $1`,
					[id]
				);
	return row?.n ?? 0;
}
