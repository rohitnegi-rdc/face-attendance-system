// Missed days a pump can ask to have counted (regularisation, migration 048), shared by the app
// (src/lib/server/regularisation.ts) and the worker's daily push (worker/regularisationPush.js).
// A day is missed when, before today (IST), the pump was Active or Idle (its latest pump_day_status
// row on or before the day; no row means Inactive, so nothing before its first row counts), no
// photo arrived (a session that did not fail), nobody is counted for it, and no request is pending
// or approved for it. A rejected, cancelled or undone request leaves the day open again.

// $1 the pump ids (uuid[]), $2 today in IST ('YYYY-MM-DD'), $3 the earliest day wanted or NULL.
export const MISSING_DAYS_SQL = `
	WITH firsts AS (
	  SELECT pump_id, min(day) AS first_day FROM pump_day_status
	  WHERE pump_id = ANY($1::uuid[]) GROUP BY pump_id
	), days AS (
	  SELECT f.pump_id, d::date AS day
	  FROM firsts f
	  CROSS JOIN LATERAL generate_series(GREATEST(f.first_day, COALESCE($3::date, f.first_day)),
	                                     $2::date - 1, interval '1 day') d
	)
	SELECT d.pump_id, to_char(d.day, 'YYYY-MM-DD') AS day, st.status
	FROM days d
	CROSS JOIN LATERAL (
	  SELECT s.status FROM pump_day_status s
	  WHERE s.pump_id = d.pump_id AND s.day <= d.day ORDER BY s.day DESC LIMIT 1
	) st
	WHERE st.status IN ('active', 'idle')
	  AND NOT EXISTS (SELECT 1 FROM attendance_sessions a
	                  WHERE a.pump_id = d.pump_id AND a.session_date = d.day AND a.status <> 'failed')
	  AND NOT EXISTS (SELECT 1 FROM daily_person_attendance dpa
	                  WHERE dpa.pump_id = d.pump_id AND dpa.session_date = d.day)
	  AND NOT EXISTS (SELECT 1 FROM regularisations r
	                  WHERE r.pump_id = d.pump_id AND r.day = d.day AND r.status IN ('pending', 'approved'))
	ORDER BY d.day DESC, d.pump_id`;

// Today's date in India, computed in code (never the container's time zone).
export function todayInIndia(now = new Date()) {
	return new Date(now.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

/** @param {string} day @param {number} n */
export function addDays(day, n) {
	const [y, m, d] = day.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {string[]} pumpIds
 * @param {{ today?: string, from?: string | null }} [options]
 * @returns {Promise<{ pump_id: string, day: string, status: 'active' | 'idle' }[]>}
 */
export async function missingDays(db, pumpIds, { today = todayInIndia(), from = null } = {}) {
	if (pumpIds.length === 0) return [];
	const { rows } = await db.query(MISSING_DAYS_SQL, [pumpIds, today, from]);
	return rows;
}
