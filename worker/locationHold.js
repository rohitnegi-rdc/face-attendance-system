// Shift start location hold (migration 054). A start held by the location check
// (src/lib/server/locationCheck.ts) waits until location_ask_at before anyone is asked:
// - Meanwhile the pump GPS is watched. A reading near the spot where the photo was taken, from the
//   30 minutes before the photo up to location_ask_at, clears it on its own (the crew started
//   before the pump's GPS caught up, or before the pump reached the site).
// - Still held at location_ask_at: the plant managers of the pump's plant and the monitors of its
//   Area are asked, each with their own email whose Approve and Reject buttons open
//   /location/<signed token> (src/routes/location/[token]). Opening that page decides nothing (mail
//   scanners open links by themselves); it shows the shift start and decides when its button is
//   pressed.
// Used by the worker (sweepLocationHolds, every minute) and by the app (tokens, deciders, words).
import { createHmac, timingSafeEqual } from 'node:crypto';

/** @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Queryable */
/** @typedef {(level: string, fields: object, message: string) => void} Log */

// Same as LOCATION_RADIUS_M and PUMP_GPS_MAX_AGE_MINUTES in src/lib/server/locationCheck.ts.
export const RADIUS_M = 100;
const GPS_BEFORE_PHOTO_MINUTES = 30;

// How long a held start waits for the pump GPS before the plant manager is asked
// (app_settings, set at /admin/settings; src/lib/server/settings.ts reads the same key).
export const HOLD_MINUTES_KEY = 'location_hold_minutes';
export const DEFAULT_HOLD_MINUTES = 30;
export const MAX_HOLD_MINUTES = 120;

/** @param {Queryable} db */
export async function holdMinutes(db) {
	const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [
		HOLD_MINUTES_KEY
	]);
	const value = Number(rows[0]?.value);
	return rows[0] && Number.isInteger(value) && value >= 0 && value <= MAX_HOLD_MINUTES
		? value
		: DEFAULT_HOLD_MINUTES;
}

/** @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 */
export function distanceMetres(lat1, lng1, lat2, lng2) {
	/** @param {number} deg */
	const rad = (deg) => (deg * Math.PI) / 180;
	const a =
		Math.sin(rad(lat2 - lat1) / 2) ** 2 +
		Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
	return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

// --- Signed links: one per session and decider -------------------------------------------------

/** @param {string} secret @param {string} sessionId @param {string} managerId */
const signature = (secret, sessionId, managerId) =>
	createHmac('sha256', secret).update(`location:${sessionId}:${managerId}`).digest('base64url');

/** @param {string} secret @param {string} sessionId @param {string} managerId */
export const locationToken = (secret, sessionId, managerId) =>
	`${sessionId}.${managerId}.${signature(secret, sessionId, managerId)}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {string} secret @param {unknown} token */
export function readLocationToken(secret, token) {
	const [sessionId, managerId, given, extra] = String(token ?? '').split('.');
	if (extra !== undefined || !UUID.test(sessionId ?? '') || !UUID.test(managerId ?? ''))
		return null;
	const expected = Buffer.from(signature(secret, sessionId, managerId));
	const actual = Buffer.from(given ?? '');
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
	return { sessionId, managerId };
}

// --- Who decides ---------------------------------------------------------------------------------

// The plant managers of the pump's plant and the monitors of its Area, not disabled. Business heads
// only look, so they are never asked.
export const DECIDERS_SQL = `
	SELECT pm.id, pm.name, lower(pm.email) AS email, 'plant manager' AS role
	FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
	JOIN plant_manager_assignments pma ON pma.plant_id = pu.plant_id
	JOIN plant_managers pm ON pm.id = pma.manager_id
	WHERE s.id = $1 AND pm.disabled_at IS NULL
	UNION
	SELECT pm.id, pm.name, lower(pm.email), 'monitor'
	FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
	JOIN plants pl ON pl.id = pu.plant_id JOIN monitor_areas ma ON ma.area_id = pl.area_id
	JOIN plant_managers pm ON pm.id = ma.manager_id
	WHERE s.id = $1 AND pm.is_monitor AND pm.disabled_at IS NULL`;

/** @param {Queryable} db @param {string} sessionId @returns {Promise<{ id: string, name: string, email: string, role: string }[]>} */
export async function locationDeciders(db, sessionId) {
	const { rows } = await db.query(`${DECIDERS_SQL} ORDER BY 2`, [sessionId]);
	return rows;
}

// Logins ending in .rdc are made up by the system (pumps, vendors, admin): no mailbox.
/** @param {string} email */
export const hasMailbox = (email) =>
	/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !email.endsWith('.rdc');

// --- Words ---------------------------------------------------------------------------------------

/** @param {unknown} value */
const escapeHtml = (value) =>
	String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A distance as a person says it: "850 m", "4.2 km".
/** @param {number | null} metres */
export const awayText = (metres) =>
	metres === null || metres === undefined
		? 'far'
		: metres >= 1000
			? `${(metres / 1000).toFixed(1)} km`
			: `${metres} m`;

// One sentence: what went wrong, in words a plant manager reads at a glance.
/** @param {string | null} issue @param {number | null} distance */
export function holdProblem(issue, distance) {
	switch (issue) {
		case 'too_far':
			return `The operator's phone was ${distance ?? '?'} m from the pump. It must be within ${RADIUS_M} m.`;
		case 'no_phone_location':
			return "The operator's phone did not share its location, so we could not check where the crew was.";
		case 'no_pump_gps':
		case 'stale_pump_gps':
			return "The pump's GPS sent no position at the time of the photo, so we could not check where the crew was.";
		default:
			return 'We could not confirm the crew was at the pump.';
	}
}

// What the system already tried, so the manager knows it is a real question.
/** @param {string | null} issue @param {number} waitedMinutes */
export function holdWaited(issue, waitedMinutes) {
	if (issue === 'no_phone_location' || waitedMinutes <= 0) return '';
	return `We watched the pump's GPS for ${waitedMinutes} minutes after the photo. It did not show the pump at that spot.`;
}

// Everything the email and the decision page show about one held start.
/** @param {Queryable} db @param {string} sessionId @returns {Promise<any>} */
export async function loadHoldFacts(db, sessionId) {
	const { rows } = await db.query(
		`SELECT s.id, s.status, s.location_status, s.location_issue, s.location_distance_m,
		        s.location_note, s.location_link_base, s.photo_url, s.gps_lat, s.gps_lng,
		        s.pump_gps_lat, s.pump_gps_lng, s.location_auto_cleared_at IS NOT NULL AS auto_cleared,
		        GREATEST(0, round(extract(epoch FROM (s.location_ask_at - s.submitted_at)) / 60))::int
		          AS waited_minutes,
		        to_char(s.submitted_at AT TIME ZONE 'Asia/Kolkata', 'FMHH12:MI am, Dy, FMDD Mon YYYY')
		          AS sent_at,
		        to_char(s.location_decided_at AT TIME ZONE 'Asia/Kolkata', 'FMHH12:MI am, Dy, FMDD Mon YYYY')
		          AS decided_at,
		        pu.pump_code, pl.name AS plant_name, a.name AS area_name, dm.name AS decided_by,
		        (SELECT count(*)::int FROM attendance_face_evidence e WHERE e.session_id = s.id) AS faces
		 FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
		 JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		 LEFT JOIN plant_managers dm ON dm.id = s.location_decided_by
		 WHERE s.id = $1 AND s.location_status IS NOT NULL AND s.location_status <> 'ok'`,
		[sessionId]
	);
	return rows[0] ?? null;
}

// The email to one decider. Short sentences, three numbered steps, two big buttons.
/**
 * @param {any} facts @param {{ name: string }} decider
 * @param {string} approveUrl @param {string} rejectUrl
 */
export function renderLocationEmail(facts, decider, approveUrl, rejectUrl) {
	const what = 'shift start';
	const subject =
		facts.location_issue === 'too_far'
			? `Please decide: ${facts.pump_code} ${what} was ${awayText(facts.location_distance_m)} from the pump`
			: `Please decide: ${facts.pump_code} ${what}, place not confirmed`;
	const problem = holdProblem(facts.location_issue, facts.location_distance_m);
	const waited = holdWaited(facts.location_issue, facts.waited_minutes);
	const workers =
		facts.faces > 0 ? `${facts.faces} ${facts.faces === 1 ? 'person' : 'people'} in the photo` : '';
	const firstName = String(decider.name ?? '').split(/\s+/)[0] || 'there';
	/** @param {(value: unknown) => string} code @param {(word: string) => string} bold */
	const stepsWith = (code, bold) => [
		`Call the operator of pump ${code(facts.pump_code)}.`,
		`If the crew is at the pump, press ${bold('Approve')}.`,
		`If the crew is not at the pump, press ${bold('Reject')} and write why.`
	];
	const steps = stepsWith(escapeHtml, (word) => `<strong>${word}</strong>`);
	const plainSteps = stepsWith(String, (word) => word);
	/** @param {string} href @param {string} label @param {string} color */
	const button = (href, label, color) =>
		`<a href="${escapeHtml(href)}" style="display:inline-block;min-width:120px;text-align:center;padding:14px 24px;margin:0 10px 10px 0;background:${color};color:#ffffff;border-radius:8px;text-decoration:none;font-size:17px;font-weight:bold">${label}</a>`;
	const html = `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1b1f23;max-width:560px">
	<p style="margin:0 0 12px">Hello ${escapeHtml(firstName)},</p>
	<p style="margin:0 0 12px">${`A shift started at pump <strong>${escapeHtml(facts.pump_code)}</strong> (${escapeHtml(facts.plant_name)}) at <strong>${escapeHtml(facts.sent_at)}</strong>, but we could not confirm the crew was at the pump.`} <strong>Please approve or reject it.</strong></p>
	<div data-location-problem style="margin:0 0 16px;padding:12px 14px;background:#fff4e5;border-left:4px solid #e07b00;border-radius:4px">
		<strong>Why:</strong> ${escapeHtml(problem)}${waited ? `<br>${escapeHtml(waited)}` : ''}${workers ? `<br>${escapeHtml(workers)}.` : ''}
	</div>
	${facts.photo_cid ? `<p style="margin:0 0 16px"><img src="cid:${facts.photo_cid}" alt="Shift start photo" style="max-width:100%;border-radius:6px"></p>` : ''}
	<p style="margin:0 0 6px"><strong>What to do:</strong></p>
	<ol style="margin:0 0 16px;padding-left:22px">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
	<p style="margin:0 0 8px">${button(approveUrl, 'Approve', '#0b6e69')}${button(rejectUrl, 'Reject', '#b3261e')}</p>
	<p style="margin:0 0 12px;color:#b3261e"><strong>Until you decide, this ${what} is not counted.</strong></p>
	<p style="margin:0;color:#5f6b76;font-size:13px">Each button opens a page where you confirm. Nothing changes until you press the button on that page.</p>
</div>`;
	const text = [
		`Hello ${firstName},`,
		'',
		`A shift started at pump ${facts.pump_code} (${facts.plant_name}) at ${facts.sent_at}, but we could not confirm the crew was at the pump. Please approve or reject it.`,
		'',
		`Why: ${problem}`,
		...(waited ? [waited] : []),
		...(workers ? [`${workers}.`] : []),
		'',
		'What to do:',
		...plainSteps.map((step, i) => `${i + 1}. ${step}`),
		'',
		`Approve: ${approveUrl}`,
		`Reject: ${rejectUrl}`,
		'',
		`Until you decide, this ${what} is not counted.`
	].join('\n');
	return { subject, html, text };
}

// One message per decider with a mailbox, each with their own signed link.
/** @param {Queryable} db @param {string} secret @param {string} sessionId */
export async function buildLocationMessages(db, secret, sessionId) {
	const facts = await loadHoldFacts(db, sessionId);
	if (!facts || facts.location_status !== 'pending') return { facts, messages: [] };
	const deciders = (await locationDeciders(db, sessionId)).filter((d) => hasMailbox(d.email));
	const base = String(facts.location_link_base ?? '').replace(/\/$/, '');
	const withPhoto = { ...facts, photo_cid: facts.photo_url ? 'shift-photo' : null };
	const messages = deciders.map((decider) => {
		const open = `${base}/location/${locationToken(secret, sessionId, decider.id)}`;
		const approveUrl = `${open}?do=approve`;
		const rejectUrl = `${open}?do=reject`;
		return {
			to: decider.email,
			deciderRole: decider.role,
			approveUrl,
			rejectUrl,
			photoPath: facts.photo_url,
			...renderLocationEmail(withPhoto, decider, approveUrl, rejectUrl)
		};
	});
	return { facts, messages };
}

// --- The sweep -----------------------------------------------------------------------------------

// Held starts still waiting whose pump has since reported a position near the photo spot: cleared
// on their own, with a note saying how.
/** @param {Queryable} db @param {Log} log */
export async function clearByLaterGps(db, log) {
	const { rows } = await db.query(
		`SELECT s.id, s.gps_lat, s.gps_lng, pu.pump_code,
		        json_agg(json_build_object('lat', l.lat, 'lng', l.lng, 'at', l.recorded_at)
		                 ORDER BY l.recorded_at) AS readings
		 FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
		 JOIN pump_locations l ON l.pump_id = s.pump_id
		   AND l.recorded_at > COALESCE(s.pump_gps_at, '-infinity'::timestamptz)
		   AND l.recorded_at >= s.submitted_at - make_interval(mins => $1)
		   AND l.recorded_at <= s.location_ask_at
		 WHERE s.location_status = 'pending' AND s.location_asked_at IS NULL
		   AND s.location_issue <> 'no_phone_location' AND s.gps_lat IS NOT NULL
		 GROUP BY s.id, pu.pump_code`,
		[GPS_BEFORE_PHOTO_MINUTES]
	);
	let cleared = 0;
	for (const row of rows) {
		/** @type {{ lat: number, lng: number, at: string }[]} */
		const readings = row.readings;
		const near = readings
			.map((r) => ({
				at: r.at,
				metres: Math.round(distanceMetres(row.gps_lat, row.gps_lng, r.lat, r.lng))
			}))
			.find((r) => r.metres <= RADIUS_M);
		if (!near) continue;
		const result = await db.query(
			`UPDATE attendance_sessions
			 SET location_status = 'approved', location_decided_at = now(), location_auto_cleared_at = now(),
			     location_note = 'Cleared automatically: the pump GPS was ' || $2::int || ' m from the photo spot at '
			       || to_char($3::timestamptz AT TIME ZONE 'Asia/Kolkata', 'FMHH12:MI am') || '.'
			 WHERE id = $1 AND location_status = 'pending' AND location_asked_at IS NULL`,
			[row.id, near.metres, near.at]
		);
		if (result.rowCount) {
			cleared++;
			log(
				'info',
				{ sessionId: row.id, pumpCode: row.pump_code, metres: near.metres },
				'location hold cleared automatically by the pump GPS'
			);
		}
	}
	return cleared;
}

/**
 * Held starts whose wait is over: claimed by one UPDATE (two workers never both ask), then each
 * decider is emailed.
 * @param {Queryable} db @param {Log} log @param {(db: Queryable) => Promise<boolean>} testModeOn
 * @param {(message: any, log: Log, meta: object) => Promise<unknown>} sendMail
 */
export async function askDueHolds(db, log, testModeOn, sendMail) {
	const { rows } = await db.query(
		`UPDATE attendance_sessions SET location_asked_at = now()
		 WHERE location_status = 'pending' AND location_asked_at IS NULL AND location_ask_at <= now()
		 RETURNING id`
	);
	if (!rows.length) return 0;
	const secret = process.env.JWT_SECRET?.trim();
	if (!secret) {
		log(
			'warn',
			{ sessions: rows.length },
			'location approval emails skipped: JWT_SECRET is not set for the worker'
		);
		return 0;
	}
	const { rows: switchRows } = await db.query(
		"SELECT value FROM app_settings WHERE key = 'location_approval_email'"
	);
	const emailOn = switchRows[0]?.value === 'on';
	let sent = 0;
	for (const { id } of rows) {
		const { facts, messages } = await buildLocationMessages(db, secret, id);
		if (!facts) continue;
		if (!messages.length) {
			// Shown on /admin/logs: nobody would hear about it otherwise.
			log(
				'warn',
				{ sessionId: id, pumpCode: facts.pump_code, plant: facts.plant_name },
				'location approval: no plant manager or monitor with a mailbox for this pump; it waits on the Approvals page'
			);
			continue;
		}
		const testMode = await testModeOn(db);
		for (const message of messages) {
			await sendMail(message, log, { sessionId: id, testMode, emailOn });
			sent++;
		}
	}
	return sent;
}

/**
 * @param {Queryable} db @param {Log} log @param {(db: Queryable) => Promise<boolean>} testModeOn
 * @param {(message: any, log: Log, meta: object) => Promise<unknown>} sendMail
 */
export async function sweepLocationHolds(db, log, testModeOn, sendMail) {
	await clearByLaterGps(db, log);
	return askDueHolds(db, log, testModeOn, sendMail);
}
