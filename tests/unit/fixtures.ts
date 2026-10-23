// Minimal rows for the unit tests, written straight to the throwaway database that
// scripts/run-unit.mjs starts. Every test makes its own Area, so tests never see each other's data.
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const url = process.env.UNIT_DATABASE_URL;
if (!url)
	throw new Error('UNIT_DATABASE_URL is not set: run the unit tests with npm run test:unit');

export const db = new pg.Client({ connectionString: url });

export const TODAY = '2026-10-23';
export const YESTERDAY = '2026-10-22';
const DIM = 512;

function tag(prefix: string) {
	return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 10)}`.toUpperCase();
}

// A unit face vector built from a few axes, e.g. face({ 0: 0.4, 1: 0.917 }). Two faces' cosine
// similarity is then the dot product of their normalised axis weights.
export function face(axes: Record<number, number>) {
	const vector = new Array<number>(DIM).fill(0);
	for (const [axis, weight] of Object.entries(axes)) vector[Number(axis)] = weight;
	const length = Math.hypot(...vector);
	return `[${vector.map((value) => value / length).join(',')}]`;
}

export async function area() {
	const { rows: a } = await db.query('INSERT INTO areas (name) VALUES ($1) RETURNING id', [
		tag('AREA')
	]);
	const { rows: p } = await db.query(
		'INSERT INTO plants (area_id, name) VALUES ($1, $2) RETURNING id',
		[a[0].id, tag('PLANT')]
	);
	return { areaId: a[0].id as string, plantId: p[0].id as string };
}

export async function pump(plantId: string) {
	const { rows: v } = await db.query(
		'INSERT INTO vendors (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
		[tag('VENDOR'), `${tag('v').toLowerCase()}@unit.test`, 'x']
	);
	const code = tag('P');
	const { rows } = await db.query(
		`INSERT INTO pumps (plant_id, vendor_id, pump_code, login_email, password_hash)
		 VALUES ($1, $2, $3, $4, 'x') RETURNING id`,
		[plantId, v[0].id, code, `${code.toLowerCase()}@pumps.unit`]
	);
	return rows[0].id as string;
}

export async function session(
	pumpId: string,
	date: string,
	type: 'morning' | 'evening' = 'morning',
	status = 'completed'
) {
	const { rows } = await db.query(
		`INSERT INTO attendance_sessions (pump_id, session_date, session_type, status, photo_hash)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		[pumpId, date, type, status, randomUUID()]
	);
	return rows[0].id as string;
}

export async function person(pumpId: string, status = 'active') {
	const { rows } = await db.query(
		`INSERT INTO persons (pump_id, status, display_seq)
		 VALUES ($1, $2, (SELECT COALESCE(MAX(display_seq), 0) + 1 FROM persons WHERE pump_id = $1))
		 RETURNING id`,
		[pumpId, status]
	);
	return rows[0].id as string;
}

// What the worker writes when it counts a face: the gallery face, the evidence row and the
// attendance flag for that session's slot.
export async function seen(
	personId: string,
	sessionId: string,
	vector: string,
	{ inGallery = true, isAnchor = false } = {}
) {
	const { rows } = await db.query(
		'SELECT pump_id, session_date, session_type FROM attendance_sessions WHERE id = $1',
		[sessionId]
	);
	const s = rows[0];
	const column = s.session_type === 'morning' ? 'morning_matched' : 'evening_matched';
	await db.query(
		`INSERT INTO person_face_vectors (person_id, session_id, embedding, in_gallery, is_anchor)
		 VALUES ($1, $2, $3::vector, $4, $5)`,
		[personId, sessionId, vector, inGallery, isAnchor]
	);
	await db.query(`INSERT INTO attendance_face_evidence (session_id, person_id) VALUES ($1, $2)`, [
		sessionId,
		personId
	]);
	await db.query(
		`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, ${column})
		 VALUES ($1, $2, $3, true)
		 ON CONFLICT (person_id, session_date) DO UPDATE SET ${column} = true`,
		[personId, s.pump_id, s.session_date]
	);
}

export async function admin() {
	const { rows } = await db.query(
		`INSERT INTO admins (email, password_hash) VALUES ($1, 'x') RETURNING id`,
		[`${tag('admin').toLowerCase()}@unit.test`]
	);
	return rows[0].id as string;
}

export async function exists(table: string, id: string) {
	const { rowCount } = await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
	return rowCount === 1;
}
