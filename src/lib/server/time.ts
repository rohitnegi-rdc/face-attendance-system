// Explicit IST date logic, never server/container default timezone.
// See plans/MasterPlan.md §2 "Timezone: explicit IST everywhere, never server default".
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export const IST = 'Asia/Kolkata';

export function nowIST() {
	return dayjs().tz(IST);
}

export function todayIST(): string {
	return nowIST().format('YYYY-MM-DD');
}

export function hoursSince(timestamp: string | Date): number {
	const then = dayjs(timestamp).tz(IST);
	return nowIST().diff(then, 'minute') / 60;
}
