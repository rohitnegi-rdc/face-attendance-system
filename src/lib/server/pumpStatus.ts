// Pump status (migration 046), the same page for the admin, plant managers and monitors
// (src/lib/components/PumpStatusBoard.svelte): each pump's Active / Idle / Inactive for today and
// tomorrow, editable, and how many days it was each over a week, month or year. A status holds from
// its day until the pump's next one; a pump with no status was Inactive (every pump starts so, and
// the people who run it set it Active). Only today and tomorrow can be set, so past days stay as
// they were. A plant manager reaches the pumps of their plants, a monitor those of their Areas
// (manager_plants). Inactive pumps are left out of the 9 am attendance
// email (worker/attendanceDigest.js).
import { fail, type RequestEvent } from '@sveltejs/kit';
import { pool, query, queryOne } from '$lib/server/db';
import { addDaysStr, isDateKey } from '$lib/date';
import { todayIST } from '$lib/server/time';
import { isPumpWorkStatus, type PumpWorkStatus } from '$lib/pumpWorkStatus';
import { logger } from '$lib/server/log';

type Viewer = { role: string; id: string; email: string };
export type StatusPeriod = 'week' | 'month' | 'year';
const PERIODS: StatusPeriod[] = ['week', 'month', 'year'];
const PAGE_SIZE = 50;
const UUID_PATTERN = /^[0-9a-f-]{36}$/i;

// The admin sees every pump; a plant manager or monitor ($2) only those of manager_plants.
const PUMP_ALLOWED = `($1 = 'admin' OR EXISTS (
	SELECT 1 FROM manager_plants mp WHERE mp.plant_id = pu.plant_id AND mp.manager_id = $2::uuid))`;

// The week (Monday first), month or year holding `at`, and the ones before and after it.
export function periodRange(period: StatusPeriod, at: string) {
	const [y, m] = at.split('-').map(Number);
	let from: string;
	let to: string;
	if (period === 'week') {
		const weekday = (new Date(`${at}T00:00:00Z`).getUTCDay() + 6) % 7;
		from = addDaysStr(at, -weekday);
		to = addDaysStr(from, 6);
	} else if (period === 'month') {
		from = `${at.slice(0, 7)}-01`;
		to = addDaysStr(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10), -1);
	} else {
		from = `${y}-01-01`;
		to = `${y}-12-31`;
	}
	return { from, to, previous: addDaysStr(from, -1), next: addDaysStr(to, 1) };
}

export async function loadPumpStatus(viewer: Viewer, url: URL) {
	const today = todayIST();
	const tomorrow = addDaysStr(today, 1);
	const periodParam = url.searchParams.get('period') as StatusPeriod;
	const period = PERIODS.includes(periodParam) ? periodParam : 'month';
	const atParam = url.searchParams.get('at') || '';
	const at = isDateKey(atParam) && atParam <= today ? atParam : today;
	const range = periodRange(period, at);
	// Days are counted up to today: the rest of the period has not happened yet.
	const countTo = range.to < today ? range.to : today;
	const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
	const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const statusParam = url.searchParams.get('status');
	const status: PumpWorkStatus | '' = isPumpWorkStatus(statusParam) ? statusParam : '';
	const requestedPage = Number(url.searchParams.get('page') || '1');
	const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;

	const all = await query<{
		id: string;
		pump_code: string;
		plant_name: string;
		area_name: string;
		today_status: PumpWorkStatus;
		today_since: string | null;
		today_by: string | null;
		today_site: string | null;
		tomorrow_status: PumpWorkStatus;
		tomorrow_site: string | null;
		active_days: number;
		idle_days: number;
		inactive_days: number;
		strip: string | null;
	}>(
		`WITH days AS (SELECT d::date AS day FROM generate_series($3::date, $4::date, interval '1 day') d)
		 SELECT pu.id, pu.pump_code, pl.name AS plant_name, a.name AS area_name,
		        COALESCE(t.status, 'inactive') AS today_status, to_char(t.day, 'YYYY-MM-DD') AS today_since,
		        t.set_by_name AS today_by, t.site_name AS today_site,
		        COALESCE(tm.status, 'inactive') AS tomorrow_status, tm.site_name AS tomorrow_site,
		        count(d.day) FILTER (WHERE st.status = 'active')::int AS active_days,
		        count(d.day) FILTER (WHERE st.status = 'idle')::int AS idle_days,
		        count(d.day) FILTER (WHERE st.status = 'inactive')::int AS inactive_days,
		        string_agg(COALESCE(st.status, 'none'), ',' ORDER BY d.day) AS strip
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		 LEFT JOIN LATERAL (SELECT ds.status, ds.day, ds.set_by_name, ds.site_name FROM pump_day_status ds
		   WHERE ds.pump_id = pu.id AND ds.day <= $5 ORDER BY ds.day DESC LIMIT 1) t ON true
		 LEFT JOIN LATERAL (SELECT ds.status, ds.site_name FROM pump_day_status ds
		   WHERE ds.pump_id = pu.id AND ds.day <= $6 ORDER BY ds.day DESC LIMIT 1) tm ON true
		 LEFT JOIN days d ON true
		 LEFT JOIN LATERAL (SELECT CASE WHEN d.day < (pu.created_at AT TIME ZONE 'Asia/Kolkata')::date
		   THEN NULL ELSE COALESCE((SELECT ds.status FROM pump_day_status ds
		   WHERE ds.pump_id = pu.id AND ds.day <= d.day ORDER BY ds.day DESC LIMIT 1), 'inactive') END AS status) st
		   ON d.day IS NOT NULL
		 WHERE ${PUMP_ALLOWED}
		   AND ($7 = '' OR pu.pump_code ILIKE $8 OR pl.name ILIKE $8 OR a.name ILIKE $8)
		 GROUP BY pu.id, pl.name, a.name, t.status, t.day, t.set_by_name, t.site_name, tm.status,
		          tm.site_name
		 ORDER BY a.name, pl.name, pu.pump_code`,
		[viewer.role, viewer.id, range.from, countTo, today, tomorrow, q, like]
	);

	// Today's counts are over every pump the search finds, before the status filter.
	const todayCounts = { active: 0, idle: 0, inactive: 0 };
	for (const pump of all) todayCounts[pump.today_status]++;
	const shown = status ? all.filter((pump) => pump.today_status === status) : all;
	const totals = {
		pumps: shown.length,
		active_days: shown.reduce((n, p) => n + p.active_days, 0),
		idle_days: shown.reduce((n, p) => n + p.idle_days, 0),
		inactive_days: shown.reduce((n, p) => n + p.inactive_days, 0)
	};
	const totalPages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
	// Day by day for the week or month ('none' before the pump was added); a year is counts only.
	const pumps = shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(({ strip, ...pump }) => ({
		...pump,
		days: period === 'year' || !strip ? [] : (strip.split(',') as (PumpWorkStatus | 'none')[])
	}));
	return {
		pumps,
		todayCounts,
		totals,
		today,
		tomorrow,
		period,
		at,
		range: { ...range, countTo, hasNext: range.next <= today },
		filters: { q, status },
		pagination: { page, totalPages, total: shown.length }
	};
}

// Sets one pump's status and site for today or tomorrow, recording who set it. A field left out
// keeps the pump's value on that day (its latest row on or before it); an empty site clears it.
export async function setPumpDayStatus({ request, locals }: RequestEvent) {
	const viewer = locals.user!;
	const form = await request.formData();
	const pumpId = String(form.get('pump') || '');
	const day = String(form.get('day') || '');
	const statusField = form.get('status');
	const siteField = form.get('site');
	const site = siteField === null ? undefined : String(siteField).trim().replace(/\s+/g, ' ');
	const today = todayIST();
	if (day !== today && day !== addDaysStr(today, 1))
		return fail(400, { message: 'Only today and tomorrow can be changed.' });
	if (!UUID_PATTERN.test(pumpId) || (statusField !== null && !isPumpWorkStatus(statusField)))
		return fail(400, { message: 'Choose Active, Idle or Inactive.' });
	if (site !== undefined && site.length > 80)
		return fail(400, { message: 'Keep the site name to 80 characters.' });
	const pump = await queryOne<{ pump_code: string }>(
		`SELECT pu.pump_code FROM pumps pu WHERE pu.id = $3 AND ${PUMP_ALLOWED}`,
		[viewer.role, viewer.id, pumpId]
	);
	if (!pump) return fail(404, { message: 'Pump not found.' });
	const manager =
		viewer.role === 'admin'
			? null
			: await queryOne<{ name: string }>('SELECT name FROM plant_managers WHERE id = $1', [
					viewer.id
				]);
	const before = await queryOne<{ status: PumpWorkStatus; site_name: string | null }>(
		`SELECT status, site_name FROM pump_day_status WHERE pump_id = $1 AND day <= $2
		 ORDER BY day DESC LIMIT 1`,
		[pumpId, day]
	);
	const status: PumpWorkStatus = isPumpWorkStatus(statusField)
		? statusField
		: (before?.status ?? 'inactive');
	const siteName = site === undefined ? (before?.site_name ?? null) : site || null;
	try {
		await pool.query(
			`INSERT INTO pump_day_status (pump_id, day, status, site_name, set_by_role, set_by_id, set_by_name)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 ON CONFLICT (pump_id, day) DO UPDATE SET status = EXCLUDED.status,
			   site_name = EXCLUDED.site_name, set_by_role = EXCLUDED.set_by_role,
			   set_by_id = EXCLUDED.set_by_id, set_by_name = EXCLUDED.set_by_name, set_at = now()`,
			[
				pumpId,
				day,
				status,
				siteName,
				viewer.role === 'admin' ? 'admin' : 'plant_manager',
				viewer.id,
				manager?.name ?? viewer.email
			]
		);
		// A new site carries into tomorrow's row when tomorrow had the same site as today; a
		// different site typed for tomorrow stays.
		const oldSite = before?.site_name ?? null;
		if (siteName !== oldSite)
			await pool.query(
				`UPDATE pump_day_status SET site_name = $3
				 WHERE pump_id = $1 AND day > $2 AND site_name IS NOT DISTINCT FROM $4`,
				[pumpId, day, siteName, oldSite]
			);
	} catch (saveError) {
		logger.error({ pumpId, day, error: String(saveError) }, 'pump status save failed');
		return fail(500, { message: 'The status was not saved. Try again.' });
	}
	return {
		success: true,
		pumpCode: pump.pump_code,
		day,
		status,
		site: siteName,
		siteChanged: siteName !== (before?.site_name ?? null)
	};
}
