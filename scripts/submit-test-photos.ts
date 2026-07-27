// End-to-end smoke test: logs in as a seeded pump, submits the two real test
// photos (Test/faces/group_morning.jpg, group_evening.jpg) through the ACTUAL
// submit -> worker -> AI service -> fraud/match pipeline, backdating the
// morning session by 10h so the 9-hour rule passes immediately (test-only).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://attendance:attendance@localhost:5432/attendance';

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function login(email: string, password: string): Promise<string> {
	const res = await fetch(`${APP_URL}/api/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email, password })
	});
	if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
	const setCookie = res.headers.get('set-cookie');
	if (!setCookie) throw new Error('no session cookie returned');
	return setCookie.split(';')[0];
}

async function submitPhoto(cookie: string, photoPath: string) {
	const buf = fs.readFileSync(photoPath);
	const form = new FormData();
	form.append('photo', new Blob([buf]), path.basename(photoPath));
	const res = await fetch(`${APP_URL}/api/attendance/submit`, {
		method: 'POST',
		headers: { cookie, origin: APP_URL },
		body: form
	});
	const body = await res.json();
	if (!res.ok) throw new Error(`submit failed: ${res.status} ${JSON.stringify(body)}`);
	return body;
}

async function pollStatus(cookie: string, sessionId: string) {
	for (let i = 0; i < 60; i++) {
		const res = await fetch(`${APP_URL}/api/attendance/status/${sessionId}`, { headers: { cookie } });
		const body = await res.json();
		if (body.status === 'completed' || body.status === 'failed') return body;
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error('timed out polling status');
}

async function main() {
	const email = 'bglprvn1@pumps.local';
	const password = 'Test1234!';
	console.log(`logging in as ${email}...`);
	const cookie = await login(email, password);

	console.log('submitting MORNING photo...');
	const morning = await submitPhoto(cookie, path.join(__dirname, '..', 'Test', 'faces', 'group_morning.jpg'));
	console.log('morning session:', morning.session_id);
	const morningResult = await pollStatus(cookie, morning.session_id);
	console.log('morning result:', JSON.stringify(morningResult, null, 2));

	console.log('backdating morning session submitted_at by 10 hours (test-only, to pass 9-hour rule)...');
	await pool.query(
		`UPDATE attendance_sessions SET submitted_at = submitted_at - interval '10 hours' WHERE id = $1`,
		[morning.session_id]
	);

	console.log('submitting EVENING photo...');
	const evening = await submitPhoto(cookie, path.join(__dirname, '..', 'Test', 'faces', 'group_evening.jpg'));
	console.log('evening session:', evening.session_id);
	const eveningResult = await pollStatus(cookie, evening.session_id);
	console.log('evening result:', JSON.stringify(eveningResult, null, 2));

	const { rows } = await pool.query(
		`SELECT dpa.person_id, dpa.morning_matched, dpa.evening_matched
		 FROM daily_person_attendance dpa
		 JOIN pumps p ON p.id = dpa.pump_id
		 WHERE p.login_email = $1
		 ORDER BY dpa.updated_at`,
		[email]
	);
	console.log('\nFinal daily_person_attendance for this pump today:');
	console.table(rows);

	await pool.end();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
