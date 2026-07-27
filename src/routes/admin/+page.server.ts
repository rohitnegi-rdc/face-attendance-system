import type { PageServerLoad } from './$types';
import { queryOne } from '$lib/server/db';
import { todayIST } from '$lib/server/time';

export const load: PageServerLoad = async () => {
	const today = todayIST();

	const attendanceToday = await queryOne<any>(
		`SELECT COUNT(*) FILTER (WHERE morning_matched AND evening_matched) AS present,
		        COUNT(*) AS total
		 FROM daily_person_attendance WHERE session_date = $1`,
		[today]
	);
	const activePumps = await queryOne<any>(
		`SELECT COUNT(DISTINCT pump_id) AS c FROM attendance_sessions WHERE session_date = $1`,
		[today]
	);
	const totalPersons = await queryOne<any>(`SELECT COUNT(*) AS c FROM persons WHERE status = 'active'`);
	const fraudToday = await queryOne<any>(
		`SELECT COUNT(*) AS c FROM fraud_flags WHERE created_at::date = $1`,
		[today]
	);
	const pendingGuests = await queryOne<any>(`SELECT COUNT(*) AS c FROM flagged_guests WHERE reviewed = false`);
	const avgElapsed = await queryOne<any>(
		`SELECT AVG(EXTRACT(EPOCH FROM (b.submitted_at - a.submitted_at)) / 3600) AS avg_hours
		 FROM attendance_sessions a JOIN attendance_sessions b ON b.id = a.paired_session_id
		 WHERE a.session_type = 'morning' AND a.session_date = $1`,
		[today]
	);

	return {
		metrics: {
			attendancePct: attendanceToday.total > 0 ? Math.round((attendanceToday.present / attendanceToday.total) * 100) : 0,
			activePumps: Number(activePumps.c),
			totalPersons: Number(totalPersons.c),
			fraudFlagsToday: Number(fraudToday.c),
			pendingGuestReviews: Number(pendingGuests.c),
			avgElapsedHours: avgElapsed.avg_hours ? Number(avgElapsed.avg_hours).toFixed(1) : 'N/A'
		}
	};
};
