// Shared by the regularisation calendar scenarios and its screenshot tests.
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PASSWORD, createArea, createPump, db } from './helpers';

export const todayIST = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);

export function daysAgo(n: number) {
	const [y, m, d] = todayIST().split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

export const monthOf = (day: string) => day.slice(0, 7);

export async function signIn(page: Page, email: string) {
	await page.goto('/login');
	await page.getByTestId('login-email').fill(email);
	await page.getByTestId('login-password').fill(PASSWORD);
	await page.getByTestId('login-submit').click();
	await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

export async function noSidewaysScroll(page: Page, width = 390) {
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
		width
	);
}

// A pump Active since eight days ago. Crew 1 to 3 did a full shift twenty days ago; Crew 4 was
// detected once but has no attendance.
export async function crewPump() {
	const { areaId, plantId } = await createArea();
	const pump = await createPump(plantId);
	await db.query(`UPDATE pumps SET created_at = now() - interval '40 days' WHERE id = $1`, [
		pump.id
	]);
	const { rows } = await db.query(
		`INSERT INTO persons (pump_id, display_seq, name)
		 SELECT $1, n, 'Crew ' || n FROM generate_series(1, 4) n RETURNING id`,
		[pump.id]
	);
	const workers = rows.map((r) => r.id as string);
	await addDay(
		pump.id,
		daysAgo(20),
		workers.slice(0, 3).map((id) => ({ id, start: true, end: true }))
	);
	await db.query(
		`INSERT INTO pump_day_status (pump_id, day, status, set_by_role, set_by_id, set_by_name)
		 VALUES ($1, $2, 'active', 'admin', $3, 'Regression')`,
		[pump.id, daysAgo(8), randomUUID()]
	);
	return { pump, areaId, plantId, workers };
}

// One day with a real photo: `people` as counted, the start shift `pairing` open or finished.
export async function addDay(
	pumpId: string,
	day: string,
	people: { id: string; start: boolean; end: boolean }[],
	pairing: 'open' | 'expired' | 'paired' = 'expired'
) {
	await db.query(
		`INSERT INTO attendance_sessions (pump_id, session_date, session_type, status, photo_hash, pairing_status)
		 VALUES ($1, $2, 'morning', 'completed', $3, $4)`,
		[pumpId, day, randomUUID(), pairing]
	);
	for (const person of people) {
		await db.query(
			`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched, evening_matched)
			 VALUES ($1, $2, $3, $4, $5)`,
			[person.id, pumpId, day, person.start, person.end]
		);
	}
}

export type CalendarDay = {
	day: string;
	state: string;
	note: string | null;
	canApply: boolean;
	counted: string[];
	request: { id: string; status: string } | null;
};

// The pump's calendar entry for one day, read from the month it falls in.
export async function calendarDay(phone: APIRequestContext, day: string): Promise<CalendarDay> {
	const response = await phone.get(`/api/pump/regularisation?month=${monthOf(day)}`);
	expect(response.status(), await response.text()).toBe(200);
	const body = (await response.json()) as { days: CalendarDay[] };
	return body.days.find((d) => d.day === day)!;
}

// The pump screen's Send: multipart with one `workers` field per ticked worker.
export async function askFor(
	phone: APIRequestContext,
	day: string,
	workers: string[],
	reason = 'no_network'
) {
	const form = new FormData();
	form.set('day', day);
	form.set('reason', reason);
	for (const w of workers) form.append('workers', w);
	return phone.post('/api/pump/regularisation', { multipart: form });
}

// Opens the month holding `day`: the calendar starts on the current month or the latest missed day.
export async function showMonth(page: Page, day: string) {
	const cell = page.locator(`[data-testid="reg-cal-day"][data-day="${day}"]`);
	for (let i = 0; i < 3 && (await cell.count()) === 0; i++) {
		await page.getByTestId('reg-cal-prev').click();
		await page.waitForTimeout(150);
	}
	await expect(cell).toBeVisible();
	return cell;
}
