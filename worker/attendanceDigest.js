// The 9 am attendance tracker for the previous day (migration 045): one email per Area and day.
// Every Active and Idle pump of the Area that day (pump_day_status, migration 046), grouped by Plant, with
// its full shift, start only and end only counts; a pump with no one counted is a red row in the
// email. Inactive (closed) pumps, and pumps never set Active or Idle, are left out. To: every
// admin and the Area's monitors. CC: only the admin's list (app_settings `digest_cc`, edited at
// /admin/settings, first filled by migration 045); no list, no CC. The attendance_digest_log row ('area:<id>', day) is
// claimed before sending, so two workers never both send it. Only Areas ticked at /admin/settings
// (areas.digest_enabled, Mumbai to start) get it, and no email for an Area whose pumps are all
// Inactive.

/** @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Queryable */
/** @typedef {(level: string, fields: object, message: string) => void} Log */
/**
 * @typedef {{ id: string, pump_code: string, plant_id: string, plant_name: string, area_name: string,
 *   site_name: string | null, start_at: Date | null, end_at: Date | null, full_shift: number, start_only: number,
 *   end_only: number, workers: number, mtd_workers: number, regularised: boolean }} DigestPump
 */
/** @typedef {{ full_shift: number, start_only: number, end_only: number, workers: number, mtd_workers: number }} Counts */
/**
 * @typedef {{ to: string[], cc: string[], area: string, day: string,
 *   areas: { name: string, plants: { id: string, name: string, pumps: DigestPump[], totals: Counts }[] }[],
 *   totals: Counts & { pumps: number, marked: number },
 *   mtd: { pump_days: number, marked: number } }} DigestMessage
 */

export const DIGEST_HOUR_IST = 9;
// Keep in sync with DIGEST_CC_KEY / DIGEST_FIRST_DAY_KEY in src/lib/server/settings.ts.
export const DIGEST_CC_KEY = 'digest_cc';
// The first day an email reports on (YYYY-MM-DD); no email is about an earlier day.
export const DIGEST_FIRST_DAY_KEY = 'digest_first_day';

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

// IST date and hour, computed in code (never the container time zone).
/** @param {Date} date */
function istNow(date) {
	const ist = new Date(date.getTime() + 330 * 60_000);
	return { day: ist.toISOString().slice(0, 10), hour: ist.getUTCHours() };
}

/** @param {string} day */
function previousDay(day) {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - 1);
	return d.toISOString().slice(0, 10);
}

/** @param {unknown} value @returns {string[]} */
export function parseCcList(value) {
	return [
		...new Set(
			String(value ?? '')
				.split(/[\s,;]+/)
				.map((e) => e.trim().toLowerCase())
				.filter((e) => EMAIL.test(e))
		)
	];
}

/** @param {Queryable} db */
async function alwaysCc(db) {
	const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [DIGEST_CC_KEY]);
	return rows.length ? parseCcList(rows[0].value) : [];
}

// The pump's status on `day` ($1): its latest pump_day_status row on or before it, else Inactive
// (migration 046: every pump starts Inactive until someone sets it Active or Idle).
const WORKING_ON_DAY = `COALESCE((SELECT ds.status FROM pump_day_status ds WHERE ds.pump_id = pu.id
  AND ds.day <= $1 ORDER BY ds.day DESC LIMIT 1), 'inactive') <> 'inactive'`;
// A pump added after `day` ($1) is not a zero for it.
const EXISTED_BY_DAY = `pu.created_at < (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;

// Every Active and Idle pump of one Area, with its counts on `day` (zero when it sent no photo)
// and for the month so far.
/**
 * @param {Queryable} db
 * @param {string} day
 * @param {string} areaId
 * @returns {Promise<DigestPump[]>}
 */
export async function digestPumps(db, day, areaId) {
	const { rows } = await db.query(
		`SELECT pu.id, pu.pump_code, pl.id AS plant_id, pl.name AS plant_name, a.name AS area_name,
		        (SELECT count(*)::int FROM daily_person_attendance m
		          WHERE m.pump_id = pu.id AND m.session_date BETWEEN $3::date AND $1::date
		            AND (m.morning_matched OR m.evening_matched)) AS mtd_workers,
		        (SELECT ds.site_name FROM pump_day_status ds WHERE ds.pump_id = pu.id AND ds.day <= $1
		          ORDER BY ds.day DESC LIMIT 1) AS site_name,
		        (SELECT min(s.submitted_at) FROM attendance_sessions s WHERE s.pump_id = pu.id
		          AND s.session_date = $1 AND s.session_type = 'morning' AND s.status <> 'failed') AS start_at,
		        (SELECT max(s.submitted_at) FROM attendance_sessions s WHERE s.pump_id = pu.id
		          AND s.session_date = $1 AND s.session_type = 'evening' AND s.status <> 'failed') AS end_at,
		        bool_or(d.regularisation_id IS NOT NULL) IS TRUE AS regularised,
		        count(d.person_id) FILTER (WHERE d.morning_matched AND d.evening_matched)::int AS full_shift,
		        count(d.person_id) FILTER (WHERE d.morning_matched AND NOT d.evening_matched)::int AS start_only,
		        count(d.person_id) FILTER (WHERE d.evening_matched AND NOT d.morning_matched)::int AS end_only
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		 LEFT JOIN daily_person_attendance d ON d.pump_id = pu.id AND d.session_date = $1
		 WHERE ${WORKING_ON_DAY} AND pl.area_id = $2 AND ${EXISTED_BY_DAY}
		 GROUP BY pu.id, pl.id, a.name
		 ORDER BY a.name, pl.name, pu.pump_code`,
		[day, areaId, `${day.slice(0, 7)}-01`]
	);
	return rows.map((row) => ({
		...row,
		workers: row.full_shift + row.start_only + row.end_only
	}));
}

// The Area's pump days this month, up to and including `day`: a pump counts on the days it was
// Active or Idle, and is marked on those of them when someone was counted.
/**
 * @param {Queryable} db
 * @param {string} day
 * @param {string} areaId
 * @returns {Promise<{ pump_days: number, marked: number }>}
 */
export async function digestPumpDays(db, day, areaId) {
	const { rows } = await db.query(
		`SELECT count(*)::int AS pump_days,
		        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM daily_person_attendance d
		          WHERE d.pump_id = pu.id AND d.session_date = days.day
		            AND (d.morning_matched OR d.evening_matched)))::int AS marked
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id
		 CROSS JOIN (SELECT d::date AS day
		   FROM generate_series($3::date::timestamp, $1::date::timestamp, interval '1 day') d) days
		 WHERE pl.area_id = $2
		   AND pu.created_at < ((days.day + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
		   AND COALESCE((SELECT ds.status FROM pump_day_status ds WHERE ds.pump_id = pu.id
		         AND ds.day <= days.day ORDER BY ds.day DESC LIMIT 1), 'inactive') <> 'inactive'`,
		[day, areaId, `${day.slice(0, 7)}-01`]
	);
	return rows[0];
}

// CC without the To addresses and without repeats.
/** @param {string[]} to @param {string[][]} lists */
export function ccList(to, ...lists) {
	const skip = new Set(to.map((e) => e.toLowerCase()));
	return [...new Set(lists.flat().map((e) => e.toLowerCase()))].filter((e) => !skip.has(e));
}

// Area > Plant > pumps, each plant with the sums of its pumps, and the sums of everything.
/** @param {DigestPump[]} pumps */
export function groupPumps(pumps) {
	/** @param {DigestPump[]} list @returns {Counts} */
	const sum = (list) => ({
		full_shift: list.reduce((n, p) => n + p.full_shift, 0),
		start_only: list.reduce((n, p) => n + p.start_only, 0),
		end_only: list.reduce((n, p) => n + p.end_only, 0),
		workers: list.reduce((n, p) => n + p.workers, 0),
		mtd_workers: list.reduce((n, p) => n + p.mtd_workers, 0)
	});
	/** @type {DigestMessage['areas']} */
	const areas = [];
	for (const pump of pumps) {
		let area = areas.find((a) => a.name === pump.area_name);
		if (!area) areas.push((area = { name: pump.area_name, plants: [] }));
		let plant = area.plants.find((p) => p.id === pump.plant_id);
		if (!plant)
			area.plants.push(
				(plant = { id: pump.plant_id, name: pump.plant_name, pumps: [], totals: sum([]) })
			);
		plant.pumps.push(pump);
	}
	for (const area of areas) for (const plant of area.plants) plant.totals = sum(plant.pumps);
	const marked = pumps.filter((p) => p.workers > 0).length;
	return { areas, totals: { pumps: pumps.length, marked, ...sum(pumps) } };
}

// Claims the day for `recipient`; false when another run already has it.
/** @param {Queryable} db @param {string} recipient @param {string} day */
async function claim(db, recipient, day) {
	const { rowCount } = await db.query(
		`INSERT INTO attendance_digest_log (recipient, day) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		[recipient, day]
	);
	return rowCount === 1;
}

// Called every few minutes; does nothing before 9 am IST or once the day's emails are out. While
// the admin Test mode is on (`testModeOn`) the email is logged instead of sent, like fraud alerts.
// `send` is sendAttendanceDigestEmail from worker/mailer.js (a stand-in in the unit tests).
/**
 * @param {Queryable} db
 * @param {Log} log
 * @param {(db: Queryable) => Promise<boolean>} testModeOn
 * @param {Date} now
 * @param {(message: DigestMessage, log: Log) => Promise<void>} send
 */
export async function sendAttendanceDigests(db, log, testModeOn, now, send) {
	const { day: today, hour } = istNow(now);
	if (hour < DIGEST_HOUR_IST) return;
	const day = previousDay(today);
	const { rows: first } = await db.query('SELECT value FROM app_settings WHERE key = $1', [
		DIGEST_FIRST_DAY_KEY
	]);
	if (first.length && day < first[0].value) return;
	const { rows: areas } = await db.query(
		`SELECT DISTINCT a.id, a.name FROM pumps pu
		 JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		 WHERE a.digest_enabled AND ${WORKING_ON_DAY} AND ${EXISTED_BY_DAY}
		   AND NOT EXISTS (SELECT 1 FROM attendance_digest_log l
		     WHERE l.recipient = 'area:' || a.id AND l.day = $1)
		 ORDER BY a.name`,
		[day]
	);
	if (!areas.length) return;
	const { rows: admins } = await db.query('SELECT lower(email) AS email FROM admins');
	const fixedCc = await alwaysCc(db);
	for (const area of areas) {
		if (!(await claim(db, `area:${area.id}`, day))) continue;
		const pumps = await digestPumps(db, day, area.id);
		if (!pumps.length) continue;
		const { rows: monitors } = await db.query(
			`SELECT lower(pm.email) AS email FROM monitor_areas ma
			 JOIN plant_managers pm ON pm.id = ma.manager_id
			 WHERE ma.area_id = $1 AND pm.is_monitor AND pm.disabled_at IS NULL`,
			[area.id]
		);
		// Logins ending in .rdc are made up by the system (admin@attendance.rdc): no mailbox there.
		const to = [...new Set([...admins, ...monitors].map((r) => r.email))]
			.filter((email) => !email.endsWith('.rdc'))
			.sort();
		const cc = ccList(to, fixedCc);
		const mtd = await digestPumpDays(db, day, area.id);
		const message = { to, cc, area: area.name, day, ...groupPumps(pumps), mtd };
		if (await testModeOn(db)) {
			log(
				'info',
				{ area: area.name, day, pumps: pumps.length, to: to.length, cc: cc.length },
				'attendance digest email NOT sent (test mode)'
			);
			continue;
		}
		await send(message, log);
	}
}
