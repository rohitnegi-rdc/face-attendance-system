// UI words for shift attendance. The database keeps morning/evening as identifiers:
// morning = shift start photo, evening = shift end photo.

export function shiftTypeLabel(sessionType: string) {
	return sessionType === 'evening' ? 'Shift end' : 'Shift start';
}

const CLOSED_BY_LABELS: Record<string, string> = {
	pump: 'ended by pump',
	timeout: 'auto-closed',
	admin: 'closed by admin'
};

export function shiftOutcomeLabel(session: { pairing_status: string; closed_by?: string | null }) {
	if (session.pairing_status === 'paired') return 'Full shift';
	if (session.pairing_status === 'open') return 'Waiting for end';
	const how = session.closed_by ? CLOSED_BY_LABELS[session.closed_by] : null;
	return how ? `Start only (${how})` : 'Start only';
}

// Per-worker daily result (daily_person_attendance morning/evening matched).
export const ATTENDANCE_STATUS_LABELS: Record<string, string> = {
	present: 'Full shift',
	morning_only: 'Start only',
	evening_only: 'End only',
	absent: 'Absent'
};
