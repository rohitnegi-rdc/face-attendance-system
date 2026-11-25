// LOCAL DEMO ONLY: a plant manager's day, built through the real submit -> worker -> AI service
// pipeline, so the plant manager screens can be looked at with real results.
//
//   npx tsx --import ./scripts/lib/load-env.mjs scripts/demo-plant-manager.ts
//
// Own Area "PM Demo", plant "PM Demo Plant", plant manager pmdemo@attendance.rdc (password
// DEFAULT_PASSWORD from auth.ts). Every run wipes the demo pumps' attendance, then builds today:
//   PMDEMO1  Active  full shift: started 10 hours ago (backdated, test only) and ended now,
//                    one worker of the start missing at the end (start only)
//   PMDEMO2  Active  started 3 hours ago, end not sent yet
//   PMDEMO3  Active  nobody counted yet (a red row)
//   PMDEMO4  Idle    no work today
//   PMDEMO5  Inactive (left out of the plant manager lists)
// Photos in Test/pm-demo/ (crew3-* to start PMDEMO3 by hand). Refuses anything but localhost.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { query, queryOne, pool } from '../src/lib/server/db.ts';
import { importCsv } from '../src/lib/server/csvImport.ts';
import { DEFAULT_PASSWORD, hashPassword } from '../src/lib/server/auth.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const photos = path.join(root, 'Test', 'pm-demo');
const APP_URL = process.env.DEMO_APP_URL || `http://localhost:${process.env.APP_HOST_PORT || 6100}`;
const MANAGER = 'pmdemo@attendance.rdc';
const PUMPS = [
	{ code: 'PMDEMO1', status: 'active', site: 'Lulu Mall extension, Edappally' },
	{ code: 'PMDEMO2', status: 'active', site: 'Metro pillar P-118, Kaloor' },
	{ code: 'PMDEMO3', status: 'active', site: 'Infopark phase 2, Kakkanad' },
	{ code: 'PMDEMO4', status: 'idle', site: '' },
	{ code: 'PMDEMO5', status: null, site: '' }
];
const NAMES: Record<string, string[]> = {
	crew1: ['Anil', 'Biju', 'Shaji', 'Rajesh', 'Sunil', 'Vinod', 'Manoj'],
	crew2: ['Joseph', 'Thomas', 'Babu', 'Sabu', 'Jose', 'Saji', 'Benny'],
	crew3: ['Ajith', 'Pradeep', 'Santhosh', 'Ratheesh', 'Suresh', 'Dileep', 'Gireesh']
};

function assertLocal() {
	const host = new URL(process.env.DATABASE_URL ?? '').hostname;
	if (!['localhost', '127.0.0.1', 'postgres'].includes(host))
		throw new Error('demo-plant-manager runs only against a local database');
}

const istToday = () =>
	new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

// Delete rows of `table` with ids `ids` and every row pointing at them (one level, from the
// foreign keys), FK triggers off for this transaction only. Local demo data only.
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

async function reset(pumpIds: string[], areaId: string) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SET LOCAL session_replication_role = 'replica'");
		const ids = async (sql: string, arg: unknown) =>
			(await client.query(sql, [arg])).rows.map((row) => row.id as string);
		const sessions = await ids(
			'SELECT id FROM attendance_sessions WHERE pump_id = ANY($1::uuid[])',
			pumpIds
		);
		const persons = await ids('SELECT id FROM persons WHERE pump_id = ANY($1::uuid[])', pumpIds);
		await wipe(client, 'attendance_sessions', sessions);
		await wipe(client, 'persons', persons);
		await wipe(client, 'gangs', await ids('SELECT id FROM gangs WHERE area_id = $1', areaId));
		await wipe(
			client,
			'area_workers',
			await ids('SELECT id FROM area_workers WHERE area_id = $1', areaId)
		);
		await client.query('DELETE FROM pump_day_status WHERE pump_id = ANY($1::uuid[])', [pumpIds]);
		await client.query('COMMIT');
		console.log(`reset: ${sessions.length} shifts, ${persons.length} workers removed`);
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

async function login(email: string) {
	const res = await fetch(`${APP_URL}/api/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: APP_URL },
		body: JSON.stringify({ email, password: DEFAULT_PASSWORD })
	});
	if (!res.ok) throw new Error(`${email} login failed: ${res.status} ${await res.text()}`);
	return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function approve(cookie: string, sessionId: string, crew: string) {
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
			(unnamed as string[]).map((id, i) => [id, NAMES[crew][i] ?? `${crew} ${i + 1}`])
		);
		res = await send(names);
	}
	if (!res.ok) throw new Error(`${crew} review failed: ${res.status} ${await res.text()}`);
}

// Send a group photo plus operator photo and wait until the worker has counted it.
async function submit(cookie: string, crew: string, half: 'start' | 'end') {
	const form = new FormData();
	const file = (name: string) =>
		new Blob([fs.readFileSync(path.join(photos, name))], { type: 'image/jpeg' });
	form.append('photo', file(`${crew}-${half}-group.jpg`), `${crew}-${half}-group.jpg`);
	// A fresh operator selfie each time: the same photo twice is refused as a duplicate.
	const operator = half === 'end' ? `${crew}-operator-end.jpg` : `${crew}-operator.jpg`;
	form.append('operator_photo', file(operator), operator);
	const res = await fetch(`${APP_URL}/api/attendance/submit`, {
		method: 'POST',
		headers: { cookie, origin: APP_URL },
		body: form
	});
	const body = await res.json();
	if (!res.ok) throw new Error(`${crew} ${half} failed: ${res.status} ${JSON.stringify(body)}`);
	for (let i = 0; i < 90; i++) {
		const status = await (
			await fetch(`${APP_URL}/api/attendance/status/${body.session_id}`, { headers: { cookie } })
		).json();
		if (status.status === 'completed') return body.session_id as string;
		if (status.status === 'review') {
			await approve(cookie, body.session_id, crew);
			return body.session_id as string;
		}
		if (status.status === 'failed')
			throw new Error(`${crew} ${half} failed: ${status.error_reason ?? ''}`);
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	throw new Error(`${crew} ${half} still processing after 3 minutes`);
}

const backdate = (sessionId: string, hours: number) =>
	query(
		`UPDATE attendance_sessions SET submitted_at = submitted_at - make_interval(hours => $2)
		 WHERE id = $1`,
		[sessionId, hours]
	);

async function main() {
	assertLocal();
	await importCsv(
		'Sr.No,Area Name,Plant Name,PUMP Name,Vendor Name\n' +
			PUMPS.map((p, i) => `${i + 1},PM Demo,PM Demo Plant,${p.code},PM Demo Vendor`).join('\n')
	);
	const pumps = await query<{
		id: string;
		code: string;
		email: string;
		plant_id: string;
		area_id: string;
	}>(
		`SELECT p.id, p.pump_code AS code, p.login_email AS email, p.plant_id, pl.area_id
		 FROM pumps p JOIN plants pl ON pl.id = p.plant_id
		 WHERE p.pump_code = ANY($1) ORDER BY p.pump_code`,
		[PUMPS.map((p) => p.code)]
	);
	if (pumps.length !== PUMPS.length) throw new Error('demo pumps were not all created');
	const { plant_id: plantId, area_id: areaId } = pumps[0];
	await reset(
		pumps.map((p) => p.id),
		areaId
	);
	await query(
		'UPDATE areas SET gangs_enabled = false, location_check_enabled = false WHERE id = $1',
		[areaId]
	);
	await query(
		'UPDATE pumps SET guide_done_at = COALESCE(guide_done_at, now()) WHERE id = ANY($1::uuid[])',
		[pumps.map((p) => p.id)]
	);

	// The plant manager, and the plant given to them.
	const manager = await queryOne<{ id: string }>(
		`INSERT INTO plant_managers (name, email, password_hash, must_change_password)
		 VALUES ('Demo Plant Manager', $1, $2, false)
		 ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash,
		   must_change_password = false, disabled_at = NULL
		 RETURNING id`,
		[MANAGER, await hashPassword(DEFAULT_PASSWORD)]
	);
	await query(
		`INSERT INTO plant_manager_assignments (plant_id, manager_id) VALUES ($1, $2)
		 ON CONFLICT (plant_id) DO UPDATE SET manager_id = EXCLUDED.manager_id`,
		[plantId, manager!.id]
	);

	// Today's pump status, as the plant manager sets it each morning.
	for (const spec of PUMPS) {
		if (!spec.status) continue;
		const pump = pumps.find((p) => p.code === spec.code)!;
		await query(
			`INSERT INTO pump_day_status (pump_id, day, status, site_name, set_by_role, set_by_id, set_by_name)
			 VALUES ($1, $2, $3, NULLIF($4, ''), 'plant_manager', $5, 'Demo Plant Manager')`,
			[pump.id, istToday(), spec.status, spec.site, manager!.id]
		);
	}

	const pump = (code: string) => pumps.find((p) => p.code === code)!;
	console.log('PMDEMO1: start ...');
	const c1 = await login(pump('PMDEMO1').email);
	await backdate(await submit(c1, 'crew1', 'start'), 10);
	console.log('PMDEMO1: end ...');
	await submit(c1, 'crew1', 'end');
	console.log('PMDEMO2: start ...');
	const c2 = await login(pump('PMDEMO2').email);
	await backdate(await submit(c2, 'crew2', 'start'), 3);

	console.log(`
Ready. Open ${APP_URL}/login in a phone-sized window and sign in:
  plant manager  ${MANAGER}
  password       ${DEFAULT_PASSWORD}
To watch a red pump turn green, start PMDEMO3 by hand:
  login pmdemo3@pumps.rdc, same password, photos ${photos}\\crew3-operator.jpg then crew3-start-group.jpg
Run this script again to start over.`);
}

main()
	.catch((error) => {
		console.error(error.message ?? error);
		process.exitCode = 1;
	})
	.finally(() => pool.end());
