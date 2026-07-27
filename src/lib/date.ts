// Client-safe IST-explicit date formatter — mirrors $lib/server/time.ts's dayjs setup,
// since .svelte files can't import from $lib/server.
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export const IST = 'Asia/Kolkata';

export function formatDate(value: string | Date): string {
	return dayjs(value).tz(IST).format('ddd, DD MMM YYYY');
}

export function todayStr(): string {
	return dayjs().tz(IST).format('YYYY-MM-DD');
}

export function addDaysStr(dateStr: string, days: number): string {
	return dayjs(dateStr).tz(IST).add(days, 'day').format('YYYY-MM-DD');
}

export function startOfMonthStr(dateStr: string): string {
	return dayjs(dateStr).tz(IST).startOf('month').format('YYYY-MM-DD');
}

export function daysBetween(from: string, to: string): string[] {
	const start = dayjs(from).tz(IST);
	const end = dayjs(to).tz(IST);
	const days: string[] = [];
	for (let d = start; d.isBefore(end) || d.isSame(end, 'day'); d = d.add(1, 'day')) {
		days.push(d.format('YYYY-MM-DD'));
	}
	return days;
}
