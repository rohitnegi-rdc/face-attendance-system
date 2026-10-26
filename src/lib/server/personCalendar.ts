import { query } from '$lib/server/db';
import { dateKey } from '$lib/date';

export type PersonDayStatus = 'present' | 'morning_only' | 'evening_only';

// Person x day status for the attendance calendars (admin pump page and plant manager
// attendance). One source, so both pages show the same letter for the same shift. Keys are
// "<personId>|YYYY-MM-DD"; a missing key means absent that day.
export async function personDayStatuses(
	personIds: string[],
	from: string,
	to: string
): Promise<Record<string, PersonDayStatus>> {
	if (!personIds.length) return {};
	const rows = await query<{
		person_id: string;
		session_date: string | Date;
		morning_matched: boolean;
		evening_matched: boolean;
	}>(
		`SELECT person_id, session_date, morning_matched, evening_matched
		 FROM daily_person_attendance
		 WHERE person_id = ANY($1) AND session_date >= $2 AND session_date <= $3`,
		[personIds, from, to]
	);
	const statuses: Record<string, PersonDayStatus> = {};
	for (const r of rows) {
		statuses[`${r.person_id}|${dateKey(r.session_date)}`] =
			r.morning_matched && r.evening_matched
				? 'present'
				: r.morning_matched
					? 'morning_only'
					: 'evening_only';
	}
	return statuses;
}
