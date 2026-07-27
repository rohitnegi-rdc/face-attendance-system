import type { PageServerLoad } from './$types';
import { query, queryOne } from '$lib/server/db';
import { error } from '@sveltejs/kit';
import { todayStr, addDaysStr, daysBetween } from '$lib/date';

export const load: PageServerLoad = async ({ params, url }) => {
	const pump = await queryOne<any>(
		`SELECT pu.id, pu.pump_code, pl.name AS plant_name, a.name AS area_name, v.name AS vendor_name, v.id AS vendor_id, a.id AS area_id
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

	const attendanceRows = await query<any>(
		`SELECT person_id, session_date, morning_matched, evening_matched
		 FROM daily_person_attendance
		 WHERE pump_id = $1 AND session_date >= $2 AND session_date <= $3`,
		[pump.id, from, to]
	);
	const attendanceMap: Record<string, string> = {};
	for (const r of attendanceRows) {
		const dateKey = r.session_date instanceof Date ? r.session_date.toISOString().slice(0, 10) : r.session_date;
		const status = r.morning_matched && r.evening_matched ? 'present' : r.morning_matched ? 'morning_only' : 'evening_only';
		attendanceMap[`${r.person_id}|${dateKey}`] = status;
	}

	const roster = await query<any>(
		`SELECT p.id, p.display_seq, p.first_seen_at, p.last_seen_at,
		        COALESCE(y.days_present, 0) AS days_present,
		        COALESCE(y.days_morning_only, 0) AS days_morning_only,
		        COALESCE(y.days_evening_only, 0) AS days_evening_only
		 FROM persons p
		 LEFT JOIN person_attendance_yearly y ON y.person_id = p.id AND y.year = EXTRACT(YEAR FROM now())
		 WHERE p.pump_id = $1
		 ORDER BY p.display_seq`,
		[pump.id]
	);

	const sessionLog = await query<any>(
		`SELECT id, session_type, status, pairing_status, submitted_at, processed_at, error_reason
		 FROM attendance_sessions
		 WHERE pump_id = $1 AND session_date >= $2 AND session_date <= $3
		 ORDER BY submitted_at DESC`,
		[pump.id, from, to]
	);

	const rejectionCounts = {
		nineHourRule: sessionLog.filter((s: any) => s.error_reason?.includes('9-hour rule')).length,
		duplicatePhoto: sessionLog.filter((s: any) => s.error_reason?.includes('Duplicate photo')).length,
		morningExpired: sessionLog.filter((s: any) => s.pairing_status === 'expired').length
	};

	const dailyTotals = await query<any>(
		`SELECT session_date,
		   COUNT(*) FILTER (WHERE morning_matched AND evening_matched) AS present, COUNT(*) AS total
		 FROM daily_person_attendance
		 WHERE pump_id = $1 AND session_date >= $2 AND session_date <= $3
		 GROUP BY session_date`,
		[pump.id, from, to]
	);
	const dailyTotalsMap: Record<string, { present: number; total: number }> = {};
	for (const r of dailyTotals) {
		const dateKey = r.session_date instanceof Date ? r.session_date.toISOString().slice(0, 10) : r.session_date;
		dailyTotalsMap[dateKey] = { present: Number(r.present), total: Number(r.total) };
	}
	const sparkline = days.map((d: string) => {
		const t = dailyTotalsMap[d];
		return t && t.total > 0 ? Math.round((t.present / t.total) * 100) : 0;
	});

	return {
		pump,
		roster,
		sessionLog,
		range: { from, to },
		days,
		attendanceMap,
		rejectionCounts,
		sparkline
	};
};
