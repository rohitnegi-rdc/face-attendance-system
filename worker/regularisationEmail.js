// Regularisation emails (migration 048), shared by the app (the first email, when a request is sent;
// src/lib/server/regularisation.ts) and the worker (a reminder after 24 hours, the admins after 48).
// Each approver gets their own email whose Approve and Reject buttons carry a signed link
// (/regularisation/<token>): it opens a page that shows the request again and decides only when its
// button is pressed, because mail scanners open links by themselves.
// The plant's business manager approves; a plant with none goes to every admin.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} Queryable */
/** @typedef {(level: string, fields: object, message: string) => void} Log */

/** @type {Record<string, string>} */
export const REASON_LABELS = {
	no_network: 'No network',
	phone_problem: 'Phone dead or broken',
	app_problem: 'App did not work',
	forgot: 'Forgot to take the photo',
	other: 'Something else'
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-11-05" -> "Thu, 5 Nov 2026".
/** @param {unknown} day */
export function dayLabel(day) {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day ?? ''));
	if (!m) return String(day ?? '');
	const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return `${WEEKDAYS[date.getUTCDay()]}, ${Number(m[3])} ${MONTHS[date.getUTCMonth()]} ${m[1]}`;
}

/** @param {unknown} value */
const escapeHtml = (value) =>
	String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Who decides with the link: 'b' a business manager, 'a' an admin.
/** @param {string} secret @param {string} id @param {string} role @param {string} actorId */
const signature = (secret, id, role, actorId) =>
	createHmac('sha256', secret)
		.update(`regularisation:${id}:${role}:${actorId}`)
		.digest('base64url');

/** @param {string} secret @param {string} id @param {string} role @param {string} actorId */
export const decisionToken = (secret, id, role, actorId) =>
	`${id}.${role}.${actorId}.${signature(secret, id, role, actorId)}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {string} secret @param {unknown} token */
export function readDecisionToken(secret, token) {
	const [id, role, actorId, given, extra] = String(token ?? '').split('.');
	if (extra !== undefined || !UUID.test(id ?? '') || !UUID.test(actorId ?? '')) return null;
	if (role !== 'b' && role !== 'a') return null;
	const expected = Buffer.from(signature(secret, id, role, actorId));
	const actual = Buffer.from(given ?? '');
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
	return { id, role, actorId };
}

// A business manager row of the list joins its plant once the plant is in the system (pumps added):
// by plant code, else by name (ignoring case, spaces and punctuation), and only when exactly one
// plant without a business manager matches.
export const ATTACH_WAITING_SQL = `
	WITH matched AS (
	  SELECT w.plant_code, w.manager_id, (array_agg(pl.id))[1] AS plant_id, count(*) AS n
	  FROM business_manager_waiting w
	  JOIN plants pl ON pl.external_code = w.plant_code
	    OR regexp_replace(lower(pl.name), '[^a-z0-9]+', '', 'g') = regexp_replace(lower(w.plant_name), '[^a-z0-9]+', '', 'g')
	  WHERE NOT EXISTS (SELECT 1 FROM business_manager_plants b WHERE b.plant_id = pl.id)
	  GROUP BY w.plant_code, w.manager_id
	), moved AS (
	  INSERT INTO business_manager_plants (plant_id, manager_id)
	  SELECT plant_id, manager_id FROM matched WHERE n = 1
	  ON CONFLICT (plant_id) DO NOTHING
	  RETURNING plant_id
	)
	DELETE FROM business_manager_waiting w USING matched m
	WHERE w.plant_code = m.plant_code AND m.n = 1 AND m.plant_id IN (SELECT plant_id FROM moved)`;

// A worker on a request (rw, p): the name, and on a half-counted day which half is asked for.
export const WORKER_LABEL_SQL = `COALESCE(NULLIF(p.name, ''), 'Worker ' || p.display_seq)
	|| CASE rw.adds WHEN 'end' THEN ' (end requested)' WHEN 'start' THEN ' (start requested)' ELSE '' END`;

// Everything the email and the decision page show about one request.
/** @param {Queryable} db @param {string} id @returns {Promise<any>} */
export async function loadRegularisationFacts(db, id) {
	const { rows } = await db.query(
		`SELECT r.id, r.pump_id, to_char(r.day, 'YYYY-MM-DD') AS day, r.reason, r.note,
		        r.voice_path IS NOT NULL AS has_voice, r.requested_by_role, r.requested_by_name,
		        r.requested_at, r.status, r.link_base, r.decided_by_name, r.decided_by_role,
		        r.decided_at, r.decision_reason,
		        pu.pump_code, pl.id AS plant_id, pl.name AS plant_name, a.name AS area_name,
		        COALESCE(pm.name, NULLIF(pl.manager_name, '')) AS plant_manager_name,
		        bm.id AS business_manager_id, bm.name AS business_manager_name,
		        (SELECT string_agg(${WORKER_LABEL_SQL}, ', ' ORDER BY p.display_seq)
		           FROM regularisation_workers rw JOIN persons p ON p.id = rw.person_id
		          WHERE rw.regularisation_id = r.id) AS workers,
		        EXISTS (SELECT 1 FROM regularisation_workers rw
		                WHERE rw.regularisation_id = r.id AND rw.adds IS NOT NULL) AS half_day,
		        (SELECT count(*)::int FROM regularisation_workers rw WHERE rw.regularisation_id = r.id)
		          AS worker_count,
		        (SELECT count(*)::int FROM regularisations r2 WHERE r2.pump_id = r.pump_id
		          AND date_trunc('month', r2.day) = date_trunc('month', r.day)
		          AND r2.status IN ('pending', 'approved')) AS month_count,
		        (SELECT to_char(max(s.session_date), 'YYYY-MM-DD') FROM attendance_sessions s
		          WHERE s.pump_id = r.pump_id AND s.session_date < r.day AND s.status <> 'failed')
		          AS last_photo_day
		 FROM regularisations r
		 JOIN pumps pu ON pu.id = r.pump_id JOIN plants pl ON pl.id = pu.plant_id
		 JOIN areas a ON a.id = pl.area_id
		 LEFT JOIN plant_manager_assignments pma ON pma.plant_id = pl.id
		 LEFT JOIN plant_managers pm ON pm.id = pma.manager_id
		 LEFT JOIN business_manager_plants bmp ON bmp.plant_id = pl.id
		 LEFT JOIN plant_managers bm ON bm.id = bmp.manager_id AND bm.disabled_at IS NULL
		 WHERE r.id = $1`,
		[id]
	);
	return rows[0] ?? null;
}

// Logins made up by the system (pump01@pumps.rdc, admin@attendance.rdc) have no mailbox.
/** @param {unknown} email */
const hasMailbox = (email) =>
	Boolean(email) && !String(email).trim().toLowerCase().endsWith('.rdc');

// Who gets the email: the plant's business manager, or every admin when the plant has none
// (`toAdmins` forces the admins: the 48-hour escalation).
/**
 * @param {Queryable} db @param {any} facts @param {boolean} [toAdmins]
 * @returns {Promise<{ id: string, name: string, email: string, role: 'a' | 'b' }[]>}
 */
export async function regularisationApprovers(db, facts, toAdmins = false) {
	if (!toAdmins && facts.business_manager_id) {
		const { rows } = await db.query('SELECT id, name, email FROM plant_managers WHERE id = $1', [
			facts.business_manager_id
		]);
		return rows.filter((r) => hasMailbox(r.email)).map((r) => ({ ...r, role: 'b' }));
	}
	const { rows } = await db.query('SELECT id, email, email AS name FROM admins ORDER BY email');
	return rows.filter((r) => hasMailbox(r.email)).map((r) => ({ ...r, role: 'a' }));
}

/** @type {Record<string, string>} */
const KIND_SUBJECT = {
	request: 'Regularisation',
	reminder: 'Reminder: regularisation waiting',
	escalation: 'Waiting 2 days: regularisation'
};

/** @param {number} n */
const ordinal = (n) => {
	const tens = n % 100;
	if (tens >= 11 && tens <= 13) return `${n}th`;
	return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

/** @param {any} facts @param {string} kind @param {string} openUrl */
export function renderRegularisationEmail(facts, kind, openUrl) {
	const approveUrl = `${openUrl}?do=approve`;
	const rejectUrl = `${openUrl}?do=reject`;
	const day = dayLabel(facts.day);
	const subject = `${KIND_SUBJECT[kind] ?? KIND_SUBJECT.request}: ${facts.pump_code}, ${day}`;
	const reason = REASON_LABELS[facts.reason] ?? facts.reason;
	const raisedBy =
		facts.requested_by_role === 'pump'
			? 'The pump operator'
			: facts.requested_by_role === 'plant_manager'
				? `${facts.requested_by_name} (plant manager)`
				: `${facts.requested_by_name} (admin)`;
	const rows = [
		['Pump', facts.pump_code],
		['Plant', `${facts.plant_name} (${facts.area_name})`],
		['Plant manager', facts.plant_manager_name || 'No plant manager on file'],
		[
			'Missing day',
			`${day} (${facts.half_day ? 'one photo arrived, the other is missing' : 'no photo arrived'})`
		],
		['Reason', facts.note ? `${reason}: ${facts.note}` : reason],
		...(facts.has_voice ? [['Voice note', 'Recorded. Open the request to play it.']] : []),
		['Asked by', raisedBy],
		[
			'Workers claimed',
			`${facts.worker_count} ${facts.worker_count === 1 ? 'worker' : 'workers'}${facts.workers ? `: ${facts.workers}` : ''}`
		],
		['This month', `${ordinal(facts.month_count)} regularisation for this pump`],
		['Last photo before', facts.last_photo_day ? dayLabel(facts.last_photo_day) : 'None']
	];
	const intro =
		kind === 'reminder'
			? 'This request has been waiting for a day. Please approve or reject it.'
			: kind === 'escalation'
				? 'This request has waited 2 days without a decision. Any admin can approve or reject it.'
				: facts.half_day
					? 'Some workers have only a start or only an end for this day. The pump asks for the missing half to be counted. Please check and decide.'
					: 'A pump missed a day and asks for it to be counted. Please check and decide.';
	/** @param {string} href @param {string} label @param {string} color */
	const button = (href, label, color) =>
		`<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;margin:0 8px 8px 0;background:${color};color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">${label}</a>`;
	const html = `
		<p>${escapeHtml(intro)}</p>
		<table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">
			${rows
				.map(
					([label, value]) =>
						`<tr><td style="color:#555;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td><td><strong>${escapeHtml(value)}</strong></td></tr>`
				)
				.join('')}
		</table>
		<p style="margin-top:18px">${button(approveUrl, 'Approve', '#0b6e69')}${button(rejectUrl, 'Reject', '#b3261e')}</p>
		<p style="color:#555;font-size:12px">The buttons open the request first; nothing is decided until you confirm there. An admin can also decide it in the app.</p>`;
	const text = [
		intro,
		'',
		...rows.map(([label, value]) => `${label}: ${value}`),
		'',
		`Approve: ${approveUrl}`,
		`Reject: ${rejectUrl}`
	].join('\n');
	return { subject, html, text, approveUrl, rejectUrl };
}

// One message per approver, each with their own signed link.
/** @param {Queryable} db @param {string} secret @param {string} id @param {string} kind */
export async function buildRegularisationMessages(db, secret, id, kind) {
	await db.query(ATTACH_WAITING_SQL);
	const facts = await loadRegularisationFacts(db, id);
	if (!facts || facts.status !== 'pending') return [];
	const approvers = await regularisationApprovers(db, facts, kind === 'escalation');
	return approvers.map((approver) => {
		const openUrl = `${facts.link_base}/regularisation/${decisionToken(secret, id, approver.role, approver.id)}`;
		return {
			to: approver.email,
			approverRole: approver.role,
			...renderRegularisationEmail(facts, kind, openUrl)
		};
	});
}

// Worker: a reminder to the approver 24 hours after the request, then every admin after 48 hours.
// Each is claimed by one UPDATE, so two workers never both send it.
/**
 * @param {Queryable} db @param {Log} log @param {(db: Queryable) => Promise<boolean>} testModeOn
 * @param {(message: any, log: Log, meta: object) => Promise<unknown>} sendMail
 */
export async function sendRegularisationReminders(db, log, testModeOn, sendMail) {
	const secret = process.env.JWT_SECRET?.trim();
	if (!secret) {
		log('warn', {}, 'regularisation reminders skipped: JWT_SECRET is not set for the worker');
		return 0;
	}
	let sent = 0;
	/** @type {[string, string, number][]} */
	const steps = [
		['reminder', 'reminded_at', 24],
		['escalation', 'escalated_at', 48]
	];
	for (const [kind, column, hours] of steps) {
		const { rows } = await db.query(
			`UPDATE regularisations SET ${column} = now()
			 WHERE status = 'pending' AND ${column} IS NULL AND requested_at <= now() - $1 * interval '1 hour'
			 RETURNING id`,
			[hours]
		);
		for (const { id } of rows) {
			const messages = await buildRegularisationMessages(db, secret, id, kind);
			const testMode = await testModeOn(db);
			for (const message of messages) {
				await sendMail(message, log, { regularisationId: id, kind, testMode });
				sent++;
			}
		}
	}
	return sent;
}
