// LOCAL DEMO ONLY: a pump with several gangs today, built through the real
// submit -> worker -> AI service pipeline, so the pump gang picker can be tried by hand.
//
//   npx tsx --import ./scripts/lib/load-env.mjs scripts/demo-gangs.ts
//
// It uses its own Area "Gang Demo" (plant "Gang Demo Plant", pump GANGDEMO1, login
// gangdemo1@pumps.rdc, the default pump
// password DEFAULT_PASSWORD from auth.ts) and never touches another pump. Every run first wipes
// that pump's attendance, then builds:
//   Gang 1  started 10 hours ago (backdated, test only), so its end is open now
//   Gang 2  started just now, its end waits for the 9 hour gap
//   a third gang slot free, so "New gang starting" shows too
// The photos to try the rest by hand are in Test/gang-demo/ (gangN-end-group.jpg,
// gangN-operator.jpg, gang3-start-group.jpg). Refuses to run against anything but localhost.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { query, queryOne, pool } from '../src/lib/server/db.ts';
import { importCsv } from '../src/lib/server/csvImport.ts';
import { DEFAULT_PASSWORD } from '../src/lib/server/auth.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const photos = path.join(root, 'Test', 'gang-demo');
const APP_URL = process.env.DEMO_APP_URL || `http://localhost:${process.env.APP_HOST_PORT || 6100}`;
const PUMP = 'gangdemo1@pumps.rdc';

function assertLocal() {
	const host = new URL(process.env.DATABASE_URL ?? '').hostname;
	if (!['localhost', '127.0.0.1', 'postgres'].includes(host))
		throw new Error('demo-gangs runs only against a local database');
}

function istToday() {
	return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

// Delete rows of `table` with ids `ids` and every row pointing at them (one level, found from
// the foreign keys), with FK triggers off for this transaction only. Local demo data only.
async function wipe(client: PoolClient, table: string, ids: string[]) {
	if (!ids.length) return;
	const { rows: refs } = await client.query(
		`SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
		 FROM pg_constraint c
		 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
		 WHERE c.contype = 'f' AND c.confrelid = $1::regclass AND c.conrelid <> c.confrelid`,
		[table]
	);
	for (const ref of refs)
		await client.query(`DELETE FROM ${ref.tbl} WHERE ${ref.col} = ANY($1::uuid[])`, [ids]);
	await client.query(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
}

async function reset(pumpId: string, areaId: string) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SET LOCAL session_replication_role = 'replica'");
		const ids = async (sql: string, arg: string) =>
			(await client.query(sql, [arg])).rows.map((row) => row.id as string);
		const sessions = await ids('SELECT id FROM attendance_sessions WHERE pump_id = $1', pumpId);
		const persons = await ids('SELECT id FROM persons WHERE pump_id = $1', pumpId);
		const gangs = await ids('SELECT id FROM gangs WHERE area_id = $1', areaId);
		const workers = await ids('SELECT id FROM area_workers WHERE area_id = $1', areaId);
		await wipe(client, 'attendance_sessions', sessions);
		await wipe(client, 'persons', persons);
		await wipe(client, 'gangs', gangs);
		await wipe(client, 'area_workers', workers);
		await client.query('COMMIT');
		console.log(
			`reset: ${sessions.length} shifts, ${persons.length} workers, ${gangs.length} gangs removed`
		);
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

async function login() {
	const res = await fetch(`${APP_URL}/api/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: APP_URL },
		body: JSON.stringify({ email: PUMP, password: DEFAULT_PASSWORD })
	});
	if (!res.ok) throw new Error(`pump login failed: ${res.status} ${await res.text()}`);
	return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

const NAMES: Record<string, string[]> = {
	gang1: ['Ramesh', 'Suresh', 'Mahesh', 'Dinesh', 'Rakesh', 'Naresh', 'Umesh'],
	gang2: ['Arjun', 'Bhola', 'Chandan', 'Deepak', 'Gopal', 'Hari', 'Kishan'],
	gang3: ['Lakhan', 'Mohan', 'Nandu', 'Pappu', 'Raju', 'Sonu', 'Tinku']
};

async function approve(cookie: string, sessionId: string, gang: string) {
	const send = (names: Record<string, string>) =>
		fetch(`${APP_URL}/api/attendance/approve/${sessionId}`, {
			method: 'POST',
			headers: { cookie, origin: APP_URL, 'content-type': 'application/json' },
			body: JSON.stringify({ names })
		});
	let res = await send({});
	if (res.status === 422) {
		const { unnamed = [] } = await res.json();
		const names = Object.fromEntries(
			(unnamed as string[]).map((id, i) => [id, NAMES[gang][i] ?? `${gang} ${i + 1}`])
		);
		res = await send(names);
	}
	if (!res.ok) throw new Error(`${gang} review failed: ${res.status} ${await res.text()}`);
}

async function submit(cookie: string, gang: string, shift?: string) {
	const form = new FormData();
	const file = (name: string) =>
		new Blob([fs.readFileSync(path.join(photos, name))], { type: 'image/jpeg' });
	form.append('photo', file(`${gang}-start-group.jpg`), `${gang}-start-group.jpg`);
	form.append('operator_photo', file(`${gang}-operator.jpg`), `${gang}-operator.jpg`);
	if (shift) form.append('shift', shift);
	const res = await fetch(`${APP_URL}/api/attendance/submit`, {
		method: 'POST',
		headers: { cookie, origin: APP_URL },
		body: form
	});
	const body = await res.json();
	if (!res.ok) throw new Error(`${gang} submit failed: ${res.status} ${JSON.stringify(body)}`);
	for (let i = 0; i < 90; i++) {
		const status = await (
			await fetch(`${APP_URL}/api/attendance/status/${body.session_id}`, { headers: { cookie } })
		).json();
		if (status.status === 'completed') return body.session_id as string;
		// New workers: the operator writes their names and taps Done reviewing.
		if (status.status === 'review') {
			await approve(cookie, body.session_id, gang);
			return body.session_id as string;
		}
		if (status.status === 'failed')
			throw new Error(`${gang} start ended as ${status.status}: ${status.error_reason ?? ''}`);
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	throw new Error(`${gang} start still processing after 3 minutes`);
}

async function main() {
	assertLocal();
	await importCsv(
		'Sr.No,Area Name,Plant Name,PUMP Name,Vendor Name\n1,Gang Demo,Gang Demo Plant,GANGDEMO1,Gang Demo Vendor\n'
	);
	const pump = await queryOne<{ id: string; area_id: string }>(
		`SELECT p.id, pl.area_id FROM pumps p JOIN plants pl ON pl.id = p.plant_id
		 WHERE p.login_email = $1`,
		[PUMP]
	);
	if (!pump) throw new Error(`${PUMP} was not created`);
	await reset(pump.id, pump.area_id);

	const admin = await queryOne<{ id: string; email: string }>(
		'SELECT id, email FROM admins ORDER BY created_at LIMIT 1'
	);
	if (!admin) throw new Error('no admin login: run npm run seed first');
	await query(
		'UPDATE areas SET gangs_enabled = true, location_check_enabled = false WHERE id = $1',
		[pump.area_id]
	);
	// The first sign-in guide is skipped: the demo is about the gang picker.
	await query('UPDATE pumps SET guide_done_at = COALESCE(guide_done_at, now()) WHERE id = $1', [
		pump.id
	]);
	await query(
		`INSERT INTO pump_day_status (pump_id, day, status, gangs, set_by_role, set_by_id, set_by_name)
		 VALUES ($1, $2, 'active', 3, 'admin', $3, $4)
		 ON CONFLICT (pump_id, day) DO UPDATE SET status = 'active', gangs = 3`,
		[pump.id, istToday(), admin.id, admin.email]
	);

	const cookie = await login();
	console.log('gang 1 start: sending photos...');
	const first = await submit(cookie, 'gang1');
	await query(
		`UPDATE attendance_sessions SET submitted_at = submitted_at - interval '10 hours' WHERE id = $1`,
		[first]
	);
	console.log('gang 1 started (moved 10 hours back, so its end is open)');
	console.log('gang 2 start: sending photos...');
	await submit(cookie, 'gang2', 'new');
	console.log('gang 2 started');
	// What the pump screen will show: each gang and when its end opens (the gap comes from
	// /admin/settings, so a local test gap may open Gang 2 within minutes).
	const today = await (
		await fetch(`${APP_URL}/api/attendance/today`, { headers: { cookie } })
	).json();
	const time = (value: string) =>
		new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', timeStyle: 'short' });
	for (const shift of today.gang_shifts ?? [])
		console.log(
			`  Gang ${shift.gang_code}: ${shift.people} people, end ${shift.end_open ? 'open now' : `opens ${time(shift.next_allowed_at)}`}`
		);
	console.log(`  New gang starting offered: ${today.can_start_gang ? 'yes' : 'no'}`);

	console.log(`
Ready. Open ${APP_URL}/login on a phone-sized window and sign in:
  login     ${PUMP}
  password  ${DEFAULT_PASSWORD}
The pump screen shows the gangs above as photo cards plus New gang starting.
Photos to try it by hand, in ${photos}:
  end Gang 1:       gang1-operator-end.jpg  then  gang1-end-group.jpg
  start a 3rd gang: gang3-operator.jpg  then  gang3-start-group.jpg
Run this script again to start over.`);
}

main()
	.catch((error) => {
		console.error(error.message ?? error);
		process.exitCode = 1;
	})
	.finally(() => pool.end());
