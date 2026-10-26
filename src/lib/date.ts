// Client-safe IST-explicit date formatter — mirrors $lib/server/time.ts's dayjs setup,
// since .svelte files can't import from $lib/server.
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export const IST = 'Asia/Kolkata';

export function isDateKey(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = dayjs.utc(value);
	return parsed.isValid() && parsed.format('YYYY-MM-DD') === value;
}

// Every date on screen, in reports and in emails is DD-MM-YYYY ("15-10-2026"), India time.
// The SQL to_char formats and the Excel cell format use the same pattern.
export const DATE_FORMAT = 'DD-MM-YYYY';

// A non-breaking space keeps a time on one line in narrow table cells.
const NBSP = '\u00a0';

export function formatDate(value: string | Date): string {
	const day =
		typeof value === 'string' && isDateKey(value) ? dayjs.tz(value, IST) : dayjs(value).tz(IST);
	return day.format(DATE_FORMAT);
}

// "15-10-2026, 11:16 am", India time.
export function formatDateTime(value: string | Date): string {
	return `${formatDate(value)}, ${formatTime(value)}`;
}

// "11:16 am", India time.
export function formatTime(value: string | Date): string {
	return dayjs(value).tz(IST).format('h:mm a').replace(' ', NBSP);
}

export function dateKey(value: string | Date): string {
	if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
		return value.slice(0, 10);
	}
	return dayjs(value).tz(IST).format('YYYY-MM-DD');
}

export function todayStr(): string {
	return dayjs().tz(IST).format('YYYY-MM-DD');
}

export function addDaysStr(dateStr: string, days: number): string {
	return dayjs.tz(dateStr, IST).add(days, 'day').format('YYYY-MM-DD');
}

export function startOfMonthStr(dateStr: string): string {
	return dayjs.tz(dateStr, IST).startOf('month').format('YYYY-MM-DD');
}

export function formatDayLabel(value: string): { weekday: string; date: string } {
	const d = dayjs.tz(value, IST);
	return { weekday: d.format('ddd'), date: d.format('DD-MM') };
}

// Every day of a calendar grid: the whole range, and never less than the week ending on `to`,
// so a grid always opens on at least seven days. Days with no attendance stay as empty columns
// instead of disappearing, so the dates read continuously.
export function calendarDays(from: string, to: string, minDays = 7): string[] {
	const weekStart = addDaysStr(to, 1 - minDays);
	return daysBetween(from < weekStart ? from : weekStart, to);
}

export function daysBetween(from: string, to: string): string[] {
	const start = dayjs.tz(from, IST);
	const end = dayjs.tz(to, IST);
	const days: string[] = [];
	for (let d = start; d.isBefore(end) || d.isSame(end, 'day'); d = d.add(1, 'day')) {
		days.push(d.format('YYYY-MM-DD'));
	}
	return days;
}
