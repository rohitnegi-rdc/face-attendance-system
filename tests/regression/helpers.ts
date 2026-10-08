// Shared fixtures for the regression scenarios. Accounts are created with
// must_change_password = FALSE (the column defaults to TRUE, migration 016). The database is a throwaway one created by
// scripts/run-regression.mjs, so tests create their own Areas/Pumps freely and never clean up.
import { expect, request, type APIRequestContext } from '@playwright/test';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';

export const BASE_URL = process.env.REGRESSION_BASE_URL ?? 'http://127.0.0.1:53000';
const STUB_URL = process.env.REGRESSION_STUB_URL ?? 'http://127.0.0.1:58000';
export const db = new pg.Pool({
	connectionString:
		process.env.REGRESSION_DATABASE_URL ??
		'postgres://attendance:regression@127.0.0.1:55432/attendance'
});
export const PASSWORD = 'Regression-Pass-123';
let passwordHash: string | undefined;

async function hash() {
	passwordHash ??= await bcrypt.hash(PASSWORD, 4);
	return passwordHash;
}

function tag(prefix: string) {
	return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 10)}`.toUpperCase();
}

export type Pump = { id: string; code: string; email: string; vendorId: string; plantId: string };

export async function createArea() {
	const name = tag('AREA');
	const { rows: area } = await db.query('INSERT INTO areas (name) VALUES ($1) RETURNING id', [
		name
	]);
	const { rows: plant } = await db.query(
		'INSERT INTO plants (area_id, name) VALUES ($1, $2) RETURNING id',
		[area[0].id, tag('PLANT')]
	);
	return { areaId: area[0].id as string, plantId: plant[0].id as string };
}

export async function createVendor() {
	const email = `${tag('vendor').toLowerCase()}@regression.test`;
	const { rows } = await db.query(
		'INSERT INTO vendors (name, email, password_hash, must_change_password) VALUES ($1, $2, $3, FALSE) RETURNING id',
		[tag('VENDOR'), email, await hash()]
	);
	return { id: rows[0].id as string, email };
}

export async function createPump(plantId: string, vendorId?: string): Promise<Pump> {
	const owner = vendorId ?? (await createVendor()).id;
	const code = tag('P');
	const email = `${code.toLowerCase()}@pumps.regression`;
	const { rows } = await db.query(
		`INSERT INTO pumps (plant_id, vendor_id, pump_code, login_email, password_hash, must_change_password)
		 VALUES ($1, $2, $3, $4, $5, FALSE) RETURNING id`,
		[plantId, owner, code, email, await hash()]
	);
	return { id: rows[0].id, code, email, vendorId: owner, plantId };
}

export async function createAdmin() {
	const email = `${tag('admin').toLowerCase()}@regression.test`;
	const { rows } = await db.query(
		'INSERT INTO admins (email, password_hash, must_change_password) VALUES ($1, $2, FALSE) RETURNING id',
		[email, await hash()]
	);
	return { id: rows[0].id as string, email };
}

export async function createPlantManager(plantId: string) {
	const email = `${tag('pm').toLowerCase()}@regression.test`;
	const { rows } = await db.query(
		'INSERT INTO plant_managers (name, email, password_hash, must_change_password) VALUES ($1, $2, $3, FALSE) RETURNING id',
		[tag('PM'), email, await hash()]
	);
	await db.query('INSERT INTO plant_manager_assignments (plant_id, manager_id) VALUES ($1, $2)', [
		plantId,
		rows[0].id
	]);
	return { id: rows[0].id as string, email };
}

export async function anonymous(): Promise<APIRequestContext> {
	return request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: BASE_URL } });
}

export async function login(email: string, password = PASSWORD): Promise<APIRequestContext> {
	const context = await anonymous();
	const response = await context.post('/api/auth/login', { data: { email, password } });
	expect(response.status(), await response.text()).toBe(200);
	return context;
}

// A fake photo. The stub AI service reads the marker and returns the registered faces.
// faces: identity names, or { identity, similarity } for a deliberately imperfect match.
export async function photo(
	faces: (string | { identity: string; similarity: number })[] = [],
	options: { delayMs?: number; fail?: boolean } = {}
) {
	const id = randomUUID().replace(/-/g, '');
	const normalized = faces.map((face) => (typeof face === 'string' ? { identity: face } : face));
	await fetch(`${STUB_URL}/__register`, {
		method: 'POST',
		body: JSON.stringify({ photo_id: id, faces: normalized, delay_ms: options.delayMs ?? 0 })
	});
	if (options.fail) {
		await fetch(`${STUB_URL}/__fail`, { method: 'POST', body: JSON.stringify({ photo_id: id }) });
	}
	return Buffer.concat([
		Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
		Buffer.from(` STUBPHOTO:${id} `),
		randomBytes(32),
		Buffer.from([0xff, 0xd9])
	]);
}

export async function submit(context: APIRequestContext, buffer: Buffer, mimeType = 'image/jpeg') {
	const response = await context.post('/api/attendance/submit', {
		multipart: { photo: { name: 'photo.jpg', mimeType, buffer } }
	});
	return { status: response.status(), body: await response.json().catch(() => ({})) };
}

export async function waitForSession(
	sessionId: string,
	statuses = ['review', 'completed', 'failed'],
	timeoutMs = 20_000
) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { rows } = await db.query('SELECT * FROM attendance_sessions WHERE id = $1', [sessionId]);
		if (rows[0] && statuses.includes(rows[0].status)) return rows[0];
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`session ${sessionId} did not reach ${statuses.join('/')} in ${timeoutMs}ms`);
}

// Submits a photo, waits for the worker and approves it like the operator would.
export async function recordSession(
	context: APIRequestContext,
	faces: Parameters<typeof photo>[0]
) {
	const submitted = await submit(context, await photo(faces));
	expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
	await waitForSession(submitted.body.session_id, ['review']);
	const approved = await context.post(`/api/attendance/approve/${submitted.body.session_id}`);
	expect(approved.status(), await approved.text()).toBe(200);
	return submitted.body.session_id as string;
}

// Moves a session back in time without waiting (the server compares against now()). With
// alsoPreviousDay the session and its attendance rows move to the previous calendar day.
export async function shiftBack(sessionId: string, minutes: number, alsoPreviousDay = false) {
	if (alsoPreviousDay) {
		await db.query(
			`UPDATE daily_person_attendance d
			 SET session_date = d.session_date - 1
			 FROM attendance_sessions s
			 WHERE s.id = $1 AND d.pump_id = s.pump_id AND d.session_date = s.session_date`,
			[sessionId]
		);
	}
	await db.query(
		`UPDATE attendance_sessions
		 SET submitted_at = submitted_at - make_interval(mins => $2),
		     session_date = CASE WHEN $3 THEN session_date - 1 ELSE session_date END
		 WHERE id = $1`,
		[sessionId, minutes, alsoPreviousDay]
	);
}

// Calls a SvelteKit form action the way the browser's enhanced form does, so the result says
// whether the action succeeded (a plain form POST renders the page with status 200 either way).
export async function action(
	context: APIRequestContext,
	path: string,
	form: Record<string, string>
): Promise<{ httpStatus: number; type?: string; status?: number }> {
	const response = await context.post(path, {
		form,
		headers: { accept: 'application/json', 'x-sveltekit-action': 'true' }
	});
	const body = await response.json().catch(() => ({}));
	return { httpStatus: response.status(), type: body.type, status: body.status };
}

export async function setSettings(
	admin: APIRequestContext,
	gapMinutes: number,
	windowHours: number
) {
	return action(admin, '/admin/settings?/save', {
		evening_min_gap_minutes: String(gapMinutes),
		evening_pairing_window_hours: String(windowHours)
	});
}

export async function clearSettings() {
	await db.query('DELETE FROM app_settings');
}

export async function count(sql: string, params: unknown[] = []) {
	const { rows } = await db.query(`SELECT count(*)::int AS n FROM (${sql}) q`, params);
	return rows[0].n as number;
}
