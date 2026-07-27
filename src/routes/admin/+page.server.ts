import type { PageServerLoad } from './$types';
import { query, queryOne } from '$lib/server/db';
import { todayIST } from '$lib/server/time';

export const load: PageServerLoad = async () => {
	const today = todayIST();
	const [
		attendanceToday,
		activePumps,
		totalPersons,
		fraudToday,
		pendingGuests,
		avgElapsed,
		pendingMerges,
		trend,
		recentActivity
	] = await Promise.all([
		queryOne<any>(
			`SELECT COUNT(*) FILTER (WHERE morning_matched AND evening_matched) AS present,
			        COUNT(*) AS total
			 FROM daily_person_attendance WHERE session_date = $1`,
			[today]
		),
		queryOne<any>(
			`SELECT COUNT(DISTINCT pump_id) AS c FROM attendance_sessions WHERE session_date = $1`,
			[today]
		),
		queryOne<any>(`SELECT COUNT(*) AS c FROM persons WHERE status = 'active'`),
		queryOne<any>(`SELECT COUNT(*) AS c FROM fraud_flags WHERE created_at::date = $1`, [today]),
		queryOne<any>(`SELECT COUNT(*) AS c FROM flagged_guests WHERE reviewed = false`),
		queryOne<any>(
			`SELECT AVG(EXTRACT(EPOCH FROM (b.submitted_at - a.submitted_at)) / 3600) AS avg_hours
			 FROM attendance_sessions a JOIN attendance_sessions b ON b.id = a.paired_session_id
			 WHERE a.session_type = 'morning' AND a.session_date = $1`,
			[today]
		),
		queryOne<any>(
			`SELECT COUNT(*) AS c FROM (
			   SELECT DISTINCT LEAST(p1.id, p2.id), GREATEST(p1.id, p2.id)
			   FROM persons p1
			   JOIN persons p2 ON p2.pump_id = p1.pump_id AND p2.id > p1.id AND p2.status = 'active'
			   JOIN person_face_vectors v1 ON v1.person_id = p1.id
			   JOIN person_face_vectors v2 ON v2.person_id = p2.id
			   LEFT JOIN merge_review_decisions d
			     ON d.lower_person_id = LEAST(p1.id, p2.id) AND d.higher_person_id = GREATEST(p1.id, p2.id)
			   WHERE p1.status = 'active' AND d.id IS NULL
			     AND 1 - (v1.embedding <=> v2.embedding) >= 0.55
			     AND 1 - (v1.embedding <=> v2.embedding) < $1
			 ) candidates`,
			[Number(process.env.FACE_MATCH_THRESHOLD ?? 0.68)]
		),
		query<any>(
			`WITH days AS (
			   SELECT generate_series($1::date - interval '6 days', $1::date, interval '1 day')::date AS day
			 )
			 SELECT days.day,
			        COALESCE(ROUND(
			          100.0 * COUNT(dpa.id) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched)
			          / NULLIF(COUNT(dpa.id), 0)
			        , 0), 0)::int AS attendance_pct
			 FROM days
			 LEFT JOIN daily_person_attendance dpa ON dpa.session_date = days.day
			 GROUP BY days.day ORDER BY days.day`,
			[today]
		),
		query<any>(
			`SELECT s.id, s.session_date, s.session_type, s.status, s.submitted_at,
			        pu.id AS pump_id, pu.pump_code, pl.name AS plant_name
			 FROM attendance_sessions s
			 JOIN pumps pu ON pu.id = s.pump_id
			 JOIN plants pl ON pl.id = pu.plant_id
			 ORDER BY s.submitted_at DESC LIMIT 12`
		)
	]);

	const present = Number(attendanceToday?.present ?? 0);
	const total = Number(attendanceToday?.total ?? 0);
	return {
		metrics: {
			attendancePct: total > 0 ? Math.round((present / total) * 100) : 0,
			activePumps: Number(activePumps?.c ?? 0),
			totalPersons: Number(totalPersons?.c ?? 0),
			fraudFlagsToday: Number(fraudToday?.c ?? 0),
			pendingGuestReviews: Number(pendingGuests?.c ?? 0),
			pendingMergeReviews: Number(pendingMerges?.c ?? 0),
			avgElapsedHours: avgElapsed?.avg_hours ? Number(avgElapsed.avg_hours).toFixed(1) : 'N/A'
		},
		trend,
		recentActivity
	};
};
