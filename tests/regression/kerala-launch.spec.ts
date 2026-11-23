// KER: Kerala launch readiness (2026-11-18: "I want to launch today for Kerala region so make sure
// all the Pump, Plant manager, BM, BH logins are working and showing, also the attendance flow is
// working and data is populating, Login is happening properly with the default password").
// Runs on the throwaway regression database, which is built by the same migrations as the server,
// including the imports of the pump list (027), plant managers (028), business managers (049) and
// business heads (052). No mail is sent: the 9 am email is checked through its log line.
import { expect, test, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import {
	PASSWORD,
	action,
	anonymous,
	approve,
	createAdmin,
	db,
	login,
	photo,
	shiftBack,
	submit,
	waitForSession
} from './helpers';
import { daysAgo, noSidewaysScroll, signIn, todayIST } from './regularisationHelpers';
import { sendAttendanceDigests } from '../../worker/attendanceDigest.js';

// The default password every imported pump and vendor login was given (DEFAULT_PASSWORD in auth.ts).
const DEFAULT_PASSWORD = 'Test1234!';
const SHOTS = 'artifacts/deep-build/screenshots';

const csvRows = (file: string): Record<string, string>[] =>
	parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });
const keralaPumpsInList = csvRows('db/migrations/027_pump_vendors.csv').filter(
	(r) => r['Area Name'] === 'Kerala'
);

async function kerala() {
	const { rows } = await db.query("SELECT id FROM areas WHERE name = 'Kerala'");
	expect(rows, 'Kerala area').toHaveLength(1);
	return rows[0].id as string;
}

async function pumpOf(code: string) {
	const { rows } = await db.query(
		`SELECT pu.id, pu.login_email AS email, pu.plant_id, pl.name AS plant
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id WHERE pu.pump_code = $1`,
		[code]
	);
	return rows[0] as { id: string; email: string; plant_id: string; plant: string };
}

// Plant managers, business managers and business heads sign in with Google (@rdc.in), which a test
// cannot do; Google's sign-in finds the account by email (findAccountByEmail) and gives the same
// session as a password sign-in. In the throwaway database they get the test password instead.
async function asIfGoogle(email: string) {
	await db.query('UPDATE plant_managers SET password_hash = $2 WHERE lower(email) = $1', [
		email,
		await bcrypt.hash(PASSWORD, 4)
	]);
}

async function signInWithDefault(page: Page, email: string) {
	await page.goto('/login');
	await page.getByTestId('login-email').fill(email);
	await page.getByTestId('login-password').fill(DEFAULT_PASSWORD);
	await page.getByTestId('login-submit').click();
	await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

test('KER-01 every Kerala pump and vendor from the list signs in with the default password', async ({
	page
}) => {
	const areaId = await kerala();
	const { rows: pumps } = await db.query(
		`SELECT pu.pump_code, lower(pu.login_email) AS email, pu.status, pl.name AS plant, v.name AS vendor,
		        lower(v.email) AS vendor_email
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN vendors v ON v.id = pu.vendor_id
		 WHERE pl.area_id = $1 ORDER BY pu.pump_code`,
		[areaId]
	);
	// Every pump on the list is in the system, in Kerala, with its login.
	expect(pumps.map((p) => p.email).sort()).toEqual(
		keralaPumpsInList.map((r) => r['Pump Login Email'].toLowerCase()).sort()
	);
	expect(pumps.filter((p) => p.status === 'disabled')).toEqual([]);

	for (const pump of pumps) {
		const context = await anonymous();
		const response = await context.post('/api/auth/login', {
			data: { email: pump.email, password: DEFAULT_PASSWORD }
		});
		expect(response.status(), `${pump.pump_code}: ${await response.text()}`).toBe(200);
		const screen = await context.get('/pump', { maxRedirects: 0 });
		expect(screen.status(), pump.pump_code).toBe(200);
		await context.dispose();
	}
	// A wrong password is refused.
	const wrong = await (
		await anonymous()
	).post('/api/auth/login', {
		data: { email: pumps[0].email, password: 'not-the-password' }
	});
	expect(wrong.status()).toBe(401);

	// The vendors of the Kerala pumps sign in too (asked to change the password first).
	const vendorEmails = [...new Set(pumps.map((p) => p.vendor_email as string))];
	for (const email of vendorEmails) {
		const context = await anonymous();
		const response = await context.post('/api/auth/login', {
			data: { email, password: DEFAULT_PASSWORD }
		});
		expect(response.status(), `${email}: ${await response.text()}`).toBe(200);
		await context.dispose();
	}

	// One pump in the browser at phone width, as the operator signs in.
	await page.setViewportSize({ width: 390, height: 844 });
	await signInWithDefault(page, 'kelpown1@pumps.rdc');
	await expect(page).toHaveURL(/\/pump/);
	await noSidewaysScroll(page);
	await page.screenshot({ path: `${SHOTS}/kerala-pump-mobile.png` });
});

test('KER-02 Kerala plant managers, business managers and the business head are set up and enabled', async () => {
	const areaId = await kerala();
	const { rows: plants } = await db.query(
		`SELECT pl.name, pl.external_code AS code,
		        (SELECT lower(pm.email) FROM plant_manager_assignments a JOIN plant_managers pm ON pm.id = a.manager_id
		          WHERE a.plant_id = pl.id AND pm.disabled_at IS NULL) AS plant_manager,
		        (SELECT lower(pm.email) FROM business_manager_plants b JOIN plant_managers pm ON pm.id = b.manager_id
		          WHERE b.plant_id = pl.id AND pm.disabled_at IS NULL) AS business_manager,
		        (SELECT lower(pm.email) FROM business_head_plants b JOIN plant_managers pm ON pm.id = b.manager_id
		          WHERE b.plant_id = pl.id AND pm.disabled_at IS NULL) AS business_head,
		        (SELECT count(*)::int FROM pumps pu WHERE pu.plant_id = pl.id) AS pumps
		 FROM plants pl WHERE pl.area_id = $1 ORDER BY pl.name`,
		[areaId]
	);
	console.log('Kerala plants:\n' + plants.map((p) => JSON.stringify(p)).join('\n'));

	// Plant managers from the list (028), matched to the plants by name.
	const pmByPlant = Object.fromEntries(plants.map((p) => [p.name, p.plant_manager]));
	expect(pmByPlant).toMatchObject({
		'KER-Kochi 1 Edyar': 'sebastian.shine@rdc.in',
		'KER-Kochi 2 Amb': 'asif.ta@rdc.in',
		'KER-Kottayam': 'jithin.pk@rdc.in',
		'KER-Kozikode': 'abhinand.kumar@rdc.in',
		'KER-Thrissur 1': 'scion.cs@rdc.in',
		'KER-Trivandrum 1': 'unnikrishnan.nair@rdc.in',
		'KER-Trivandrum 2': 'unnikrishnan.nair@rdc.in',
		'KER-Wayanad': 'emil.reemon@rdc.in'
	});
	// The business head of every plant on the mapping, even where its plant name is spelt
	// differently there (Edayar, Amb., Wayanand): matched by plant code.
	for (const plant of plants.filter((p) => p.name !== 'KER-Thrissur 2')) {
		expect(plant.business_head, plant.name).toBe('pretheesh.sukumaran@rdc.in');
	}
	// Nothing waits for a Kerala plant that the import could not find.
	const { rows: waiting } = await db.query(
		`SELECT plant_name FROM business_head_waiting WHERE plant_name ILIKE 'KER%'
		 UNION ALL SELECT plant_name FROM business_manager_waiting WHERE plant_name ILIKE 'KER%'`
	);
	expect(waiting).toEqual([]);

	// Every Kerala login of these roles is enabled, an @rdc.in Google account, and found by the
	// sign-in lookup as a plant-manager role (no admin or vendor with the same email first).
	const emails = [
		...new Set(
			plants.flatMap((p) => [p.plant_manager, p.business_manager, p.business_head]).filter(Boolean)
		)
	];
	for (const email of emails) {
		expect(email, email).toMatch(/@rdc\.in$/);
		const { rows } = await db.query(
			`SELECT disabled_at FROM plant_managers WHERE lower(email) = $1`,
			[email]
		);
		expect(rows, email).toHaveLength(1);
		expect(rows[0].disabled_at, email).toBeNull();
		const clash = await db.query(
			`SELECT 1 FROM admins WHERE lower(email) = $1 UNION ALL SELECT 1 FROM vendors WHERE lower(email) = $1`,
			[email]
		);
		expect(clash.rowCount, `${email} would sign in as another role`).toBe(0);
	}
});

test('KER-03 a Kerala pump sends a full shift; attendance is stored and shows for its plant manager, business head and admin', async ({
	page
}) => {
	const pump = await pumpOf('KELPOWN1');
	const other = await pumpOf('KELPOWN2'); // KER-Trivandrum 1, another plant manager
	const admin = await createAdmin();
	const counts = async () =>
		(
			await db.query(
				`SELECT (SELECT count(*)::int FROM daily_person_attendance) AS attendance,
				        (SELECT count(*)::int FROM persons WHERE pump_id <> $1) AS others`,
				[pump.id]
			)
		).rows[0];
	const before = await counts();

	// The plant manager marks the pump Active today, as on launch day (no row = Inactive).
	const manager = 'sebastian.shine@rdc.in';
	await asIfGoogle(manager);
	const pm = await login(manager);
	const today = todayIST();
	const mine = await action(pm, '/plant-manager/pump-status?/setStatus', {
		pump: pump.id,
		day: today,
		status: 'active',
		site: 'Kakkanad site'
	});
	expect(mine.type, JSON.stringify(mine)).toBe('success');
	// Another plant's pump is not theirs.
	const notMine = await action(pm, '/plant-manager/pump-status?/setStatus', {
		pump: other.id,
		day: today,
		status: 'active'
	});
	expect(notMine.type).not.toBe('success');

	// The operator signs in with the default password and sends the shift start.
	const phone = await login(pump.email, DEFAULT_PASSWORD);
	const crew = ['KER-A', 'KER-B', 'KER-C'].map((n) => `${n}-${Date.now()}`);
	const start = await submit(phone, await photo(crew));
	expect(start.status, JSON.stringify(start.body)).toBe(202);
	const startRow = await waitForSession(start.body.session_id, ['review']);
	expect(startRow.session_type).toBe('morning');
	expect(startRow.location_status).toBeNull(); // Kerala has no location check yet
	expect((await approve(phone, start.body.session_id)).status()).toBe(200);

	// The end photo after the gap: the same three workers, matched, not new.
	await shiftBack(start.body.session_id, 541);
	const end = await submit(phone, await photo(crew));
	expect(end.status, JSON.stringify(end.body)).toBe(202);
	const endRow = await waitForSession(end.body.session_id, ['review']);
	expect(endRow.session_type).toBe('evening');
	expect((await approve(phone, end.body.session_id)).status()).toBe(200);

	const { rows: days } = await db.query(
		`SELECT morning_matched, evening_matched FROM daily_person_attendance
		 WHERE pump_id = $1 AND session_date = $2`,
		[pump.id, startRow.session_date]
	);
	expect(days).toHaveLength(3);
	expect(days.every((d) => d.morning_matched && d.evening_matched)).toBe(true);
	const { rows: sessions } = await db.query(
		`SELECT session_type, status, pairing_status FROM attendance_sessions WHERE pump_id = $1 ORDER BY submitted_at`,
		[pump.id]
	);
	expect(sessions.map((s) => s.session_type)).toEqual(['morning', 'evening']);
	expect(sessions.every((s) => s.status === 'completed')).toBe(true);
	expect(sessions.every((s) => s.pairing_status === 'paired')).toBe(true);

	// Nothing else changed: only this pump's three workers were added, no other pump's people.
	const after = await counts();
	expect(after.attendance - before.attendance).toBe(3);
	expect(after.others).toBe(before.others);
	const { rows: status } = await db.query(
		'SELECT status, site_name FROM pump_day_status WHERE pump_id = $1 AND day = $2',
		[pump.id, today]
	);
	expect(status).toEqual([{ status: 'active', site_name: 'Kakkanad site' }]);

	// The plant manager's pages show the pump; not another plant's pump.
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, manager);
	await page.goto('/plant-manager/pumps');
	await expect(page.getByText('KELPOWN1').first()).toBeVisible();
	await expect(page.getByText('KELPOWN2')).toHaveCount(0);
	await page.goto('/plant-manager');
	await expect(page.getByText('KELPOWN1').first()).toBeVisible();
	await noSidewaysScroll(page);
	await page.screenshot({ path: `${SHOTS}/kerala-plant-manager-mobile.png`, fullPage: true });

	// The business head sees the Kerala plants' pumps, read only.
	const head = 'pretheesh.sukumaran@rdc.in';
	await asIfGoogle(head);
	await page.context().clearCookies();
	await signIn(page, head);
	await page.goto('/plant-manager/pumps');
	await expect(page.getByText('KELPOWN1').first()).toBeVisible();
	await noSidewaysScroll(page);
	await page.screenshot({ path: `${SHOTS}/kerala-business-head-mobile.png`, fullPage: true });

	// The admin's Kerala page lists the pump with its workers today.
	await page.context().clearCookies();
	await page.setViewportSize({ width: 1280, height: 900 });
	await signIn(page, admin.email);
	await page.goto(`/admin/areas/${await kerala()}`);
	await expect(page.getByText('KELPOWN1').first()).toBeVisible();
	await page.screenshot({ path: `${SHOTS}/kerala-admin-area-desktop.png`, fullPage: true });
});

test('KER-04 the 9 am email for Kerala goes to admins, copies the BH and plant managers, and is only logged', async () => {
	process.env.MAIL_ENABLED = 'false'; // never real mail from a test
	const areaId = await kerala();
	const admin = await createAdmin();
	const api = await login(admin.email);
	const ticked = (await db.query('SELECT id FROM areas WHERE digest_enabled')).rows.map(
		(r) => r.id as string
	);
	const pump = await pumpOf('KELPOWN5');
	try {
		// The admin ticks Kerala for the 9 am email at /admin/settings, keeping the others.
		const form = new URLSearchParams();
		for (const id of [...ticked, areaId]) form.append('area', id);
		const saved = await api.post('/admin/settings?/digestAreas', {
			data: form.toString(),
			headers: {
				accept: 'application/json',
				'x-sveltekit-action': 'true',
				'content-type': 'application/x-www-form-urlencoded'
			}
		});
		expect((await saved.json()).type).toBe('success');
		const { rows: area } = await db.query('SELECT digest_enabled FROM areas WHERE id = $1', [
			areaId
		]);
		expect(area[0].digest_enabled).toBe(true);

		// A Kerala pump was Active yesterday (and existed before it).
		await db.query(`UPDATE pumps SET created_at = now() - interval '30 days' WHERE id = $1`, [
			pump.id
		]);
		await db.query(
			`INSERT INTO pump_day_status (pump_id, day, status, set_by_role, set_by_id, set_by_name)
			 VALUES ($1, $2, 'active', 'admin', $3, 'Regression') ON CONFLICT DO NOTHING`,
			[pump.id, daysAgo(1), admin.id]
		);

		const lines: { fields: Record<string, unknown>; message: string }[] = [];
		const log = (_level: string, fields: object, message: string) => {
			lines.push({ fields: fields as Record<string, unknown>, message });
		};
		const tenAmIst = new Date(`${todayIST()}T04:30:00Z`);
		// The worker's real mail function, loaded at run time (worker/mailer.js has no JSDoc types).
		const mailer = '../../worker/mailer.js';
		const { sendAttendanceDigestEmail } = await import(/* @vite-ignore */ mailer);
		await sendAttendanceDigests(db, log, async () => false, tenAmIst, sendAttendanceDigestEmail);
		// The worker's own 5 minute sweep may have sent it first: then its log line is the record.
		let entry = lines.find(
			(l) => l.message.startsWith('attendance digest email') && l.fields.area === 'Kerala'
		)?.fields;
		if (!entry) {
			const file = `${process.env.REGRESSION_OUTPUT_DIR ?? ''}/worker.log`;
			const found = fs.existsSync(file)
				? fs
						.readFileSync(file, 'utf8')
						.split('\n')
						.filter((l) => l.includes('attendance digest email') && l.includes('"Kerala"'))
				: [];
			entry = found.length ? JSON.parse(found[0].slice(found[0].indexOf('{'))) : undefined;
		}
		console.log('Kerala 9 am email log:', JSON.stringify(entry));
		expect(entry, 'a Kerala digest log line').toBeTruthy();
		expect(lines.map((l) => l.message)).not.toContain('attendance digest email sent');
		const to = entry!.to as string[];
		const cc = entry!.cc as string[];
		expect(to.every((e) => !e.endsWith('.rdc'))).toBe(true);
		for (const email of [
			'pretheesh.sukumaran@rdc.in',
			'sebastian.shine@rdc.in',
			'asif.ta@rdc.in',
			'jithin.pk@rdc.in',
			'abhinand.kumar@rdc.in',
			'scion.cs@rdc.in',
			'unnikrishnan.nair@rdc.in',
			'emil.reemon@rdc.in'
		]) {
			expect(cc, email).toContain(email);
			expect(to, email).not.toContain(email);
		}
		expect(new Set(cc).size).toBe(cc.length);
		const logged = await db.query(
			"SELECT 1 FROM attendance_digest_log WHERE recipient = 'area:' || $1 AND day = $2",
			[areaId, daysAgo(1)]
		);
		expect(logged.rowCount).toBe(1);
	} finally {
		await db.query('UPDATE areas SET digest_enabled = (id::text = ANY($1))', [ticked]);
	}
});
