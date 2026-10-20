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

// Non-breaking spaces keep a date on one line in narrow table cells; a wrapped date is hard to
// scan. Text matchers that normalise whitespace still see "Thu, 15 Oct 2026".
const NBSP = '\u00a0';

export function formatDate(value: string | Date): string {
	const day =
		typeof value === 'string' && isDateKey(value) ? dayjs.tz(value, IST) : dayjs(value).tz(IST);
	return day.format('ddd, DD MMM YYYY').replaceAll(' ', NBSP);
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
	return { weekday: d.format('ddd'), date: d.format('D MMM') };
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
