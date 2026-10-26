// NAME, RPT-06, CORR and UI-10: the operator must name every worker before completing a photo;
// vendors and admins correct names; names reach the reports; vendors export their own pumps;
// plant managers and admins mark a worker present after a missed shift start; session logs keep
// only fraud faces on screen and load other faces on click.
import { test, expect, type APIRequestContext } from '@playwright/test';
import ExcelJS from 'exceljs';
import {
	action,
	createAdmin,
	createArea,
	createPlantManager,
	createPump,
	createVendor,
	db,
	login,
	photo,
	recordSession,
	shiftBack,
	submit,
	waitForSession
} from './helpers';

async function submitAndWait(context: APIRequestContext, faces: Parameters<typeof photo>[0]) {
	const submitted = await submit(context, await photo(faces));
	expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
	await waitForSession(submitted.body.session_id, ['review']);
	return submitted.body.session_id as string;
}

async function personIds(sessionId: string) {
	const { rows } = await db.query(
		`SELECT p.id FROM persons p
		 WHERE p.id IN (SELECT person_id FROM person_face_vectors WHERE session_id = $1)
		 ORDER BY p.display_seq`,
		[sessionId]
	);
	return rows.map((row) => row.id as string);
}

async function sessionDay(sessionId: string) {
	const { rows } = await db.query(
		'SELECT session_date::text AS day FROM attendance_sessions WHERE id = $1',
		[sessionId]
	);
	return rows[0].day as string;
}

async function sheet(context: APIRequestContext, path: string, name: string) {
	const response = await context.get(path);
	expect(response.status(), path).toBe(200);
	const book = new ExcelJS.Workbook();
	await book.xlsx.load((await response.body()) as any);
	const ws = book.getWorksheet(name)!;
	const header = (ws.getRow(1).values as any[]).slice(1);
	const out: Record<string, any>[] = [];
	ws.eachRow((row, i) => {
		if (i === 1) return;
		const values = (row.values as any[]).slice(1);
		out.push(Object.fromEntries(header.map((h, c) => [h, values[c]])));
	});
	return out;
}

test('NAME-01 the operator cannot complete a photo until every worker has a name', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const context = await login(pump.email);
	const sessionId = await submitAndWait(context, ['NAME01A', 'NAME01B']);
	const [a, b] = await personIds(sessionId);

	// No names, or one missing: refused, and the answer says which worker is missing.
	expect((await context.post(`/api/attendance/approve/${sessionId}`)).status()).toBe(422);
	const partial = await context.post(`/api/attendance/approve/${sessionId}`, {
		data: { names: { [a]: 'Ramesh Kumar' } }
	});
	expect(partial.status()).toBe(422);
	expect((await partial.json()).unnamed).toEqual([b]);
	// Not usable as a name: one letter, or digits.
	const bad = await context.post(`/api/attendance/approve/${sessionId}`, {
		data: { names: { [a]: 'R', [b]: '42' } }
	});
	expect(bad.status()).toBe(422);
	const { rows: still } = await db.query('SELECT status FROM attendance_sessions WHERE id = $1', [
		sessionId
	]);
	expect(still[0].status).toBe('review');

	// Spaces are tidied; Hindi names work.
	const ok = await context.post(`/api/attendance/approve/${sessionId}`, {
		data: { names: { [a]: '  Ramesh   Kumar ', [b]: 'सुरेश' } }
	});
	expect(ok.status(), await ok.text()).toBe(200);
	const { rows } = await db.query(
		'SELECT name, named_by FROM persons WHERE id = ANY($1) ORDER BY display_seq',
		[[a, b]]
	);
	expect(rows).toEqual([
		{ name: 'Ramesh Kumar', named_by: 'pump' },
		{ name: 'सुरेश', named_by: 'pump' }
	]);

	// Named once: the shift end photo of the same workers shows the names and needs none.
	await shiftBack(sessionId, 600);
	const end = await submitAndWait(context, ['NAME01A', 'NAME01B']);
	const status = await (await context.get(`/api/attendance/status/${end}`)).json();
	expect(status.matched.map((p: any) => p.name).sort()).toEqual(['Ramesh Kumar', 'सुरेश'].sort());
	expect((await context.post(`/api/attendance/approve/${end}`)).status()).toBe(200);
});

test('NAME-02 a name is used once per pump; another pump may use it', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const other = await createPump(plantId);
	const context = await login(pump.email);
	const first = await submitAndWait(context, ['NAME02A']);
	const [a] = await personIds(first);
	const named = await context.post(`/api/attendance/approve/${first}`, {
		data: { names: { [a]: 'Mohan Lal' } }
	});
	expect(named.status()).toBe(200);

	// A new face at the same pump given the same name (any case): refused, naming the clash.
	await shiftBack(first, 600);
	const second = await submitAndWait(context, ['NAME02A', 'NAME02B']);
	const [b] = (await personIds(second)).filter((id) => id !== a);
	const clash = await context.post(`/api/attendance/approve/${second}`, {
		data: { names: { [b]: 'mohan lal' } }
	});
	expect(clash.status()).toBe(409);
	expect((await clash.json()).duplicate).toBe('Mohan Lal');
	expect(
		(
			await context.post(`/api/attendance/approve/${second}`, {
				data: { names: { [b]: 'Mohan Lal Sharma' } }
			})
		).status()
	).toBe(200);

	// The same name at another pump is fine.
	const otherContext = await login(other.email);
	const elsewhere = await submitAndWait(otherContext, ['NAME02C']);
	const [c] = await personIds(elsewhere);
	const ok = await otherContext.post(`/api/attendance/approve/${elsewhere}`, {
		data: { names: { [c]: 'Mohan Lal' } }
	});
	expect(ok.status()).toBe(200);
});

test('NAME-03 the vendor and the admin correct a name; others cannot', async () => {
	const { plantId } = await createArea();
	const vendor = await createVendor();
	const pump = await createPump(plantId, vendor.id);
	const sessionId = await recordSession(await login(pump.email), ['NAME03']);
	const [person] = await personIds(sessionId);

	const owner = await login(vendor.email);
	expect(
		await action(owner, '/vendor/people?/rename', { person_id: person, name: 'Raju Yadav' })
	).toMatchObject({ type: 'success' });
	const people = await (await owner.get('/vendor/people')).text();
	expect(people).toContain('Raju Yadav');
	// Faces are not in the list; each opens on click.
	expect(people).toContain('data-testid="face-peek"');

	const stranger = await login((await createVendor()).email);
	expect(
		await action(stranger, '/vendor/people?/rename', { person_id: person, name: 'Someone Else' })
	).toMatchObject({ type: 'failure', status: 404 });

	const admin = await login((await createAdmin()).email);
	expect(
		await action(admin, `/admin/persons/${person}?/rename`, { name: 'Raju Prasad Yadav' })
	).toMatchObject({ type: 'success' });
	const { rows } = await db.query('SELECT name, named_by FROM persons WHERE id = $1', [person]);
	expect(rows[0]).toEqual({ name: 'Raju Prasad Yadav', named_by: 'admin' });
	const { rows: audit } = await db.query(
		`SELECT details FROM admin_audit_log WHERE action = 'rename_person' AND target_id = $1`,
		[person]
	);
	expect(audit.map((r) => r.details)).toEqual([{ from: 'Raju Yadav', to: 'Raju Prasad Yadav' }]);
});

test('RPT-06 the vendor exports its own pumps, with worker names', async () => {
	const { plantId } = await createArea();
	const vendor = await createVendor();
	const pump = await createPump(plantId, vendor.id);
	const otherPump = await createPump(plantId);
	await recordSession(await login(pump.email), ['RPT06A']);
	await recordSession(await login(otherPump.email), ['RPT06B']);

	const owner = await login(vendor.email);
	expect(await (await owner.get('/vendor/attendance')).text()).toContain(
		'data-testid="vendor-export"'
	);
	const daily = await sheet(owner, '/vendor/attendance/export', 'Daily');
	expect(daily.length).toBeGreaterThan(0);
	expect(new Set(daily.map((r) => r.Pump))).toEqual(new Set([pump.code]));
	expect(daily.map((r) => r.Name)).toEqual(['Test Worker 1']);
	const headcount = await owner.get('/vendor/attendance/export?report=headcount');
	expect(headcount.status()).toBe(200);

	// Only vendors: a plant manager or a pump is refused.
	const manager = await login((await createPlantManager(plantId)).email);
	expect((await manager.get('/vendor/attendance/export')).status()).toBe(403);
	expect((await (await login(pump.email)).get('/vendor/attendance/export')).status()).toBe(403);
});

test('CORR-01 after a missed shift start the plant manager marks the worker present', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const manager = await login((await createPlantManager(plantId)).email);
	// The pump missed the start: its only photo of the day is recorded as the start.
	const sessionId = await recordSession(await login(pump.email), ['CORR01']);
	const [person] = await personIds(sessionId);
	const day = await sessionDay(sessionId);
	const page = `/plant-manager/attendance/correct?pump=${pump.id}&day=${day}`;

	const log = await (await manager.get('/plant-manager/attendance')).text();
	expect(log).toContain('data-testid="fix-attendance"');
	expect(log.replaceAll('&amp;', '&')).toContain(page);
	expect(await (await manager.get(page)).text()).toContain('Start only');

	const form = {
		person_id: person,
		pump_id: pump.id,
		day,
		morning_present: 'on',
		evening_present: 'on'
	};
	// A reason is required.
	expect(
		await action(manager, '/plant-manager/attendance/correct?/correct', { ...form, reason: 'no' })
	).toMatchObject({ type: 'failure', status: 400 });
	expect(
		await action(manager, '/plant-manager/attendance/correct?/correct', {
			...form,
			reason: 'Pump missed the shift start, worker seen in photo'
		})
	).toMatchObject({ type: 'success' });
	const { rows } = await db.query(
		`SELECT morning_matched, evening_matched FROM daily_person_attendance
		 WHERE person_id = $1 AND session_date = $2`,
		[person, day]
	);
	expect(rows[0]).toEqual({ morning_matched: true, evening_matched: true });
	const { rows: history } = await db.query(
		`SELECT corrected_by_manager_id IS NOT NULL AS by_manager, corrected_by_admin_id
		 FROM attendance_corrections WHERE person_id = $1`,
		[person]
	);
	expect(history).toEqual([{ by_manager: true, corrected_by_admin_id: null }]);
	expect(await (await manager.get(page)).text()).toContain('Changes this day');

	// A plant manager of another plant can neither open nor change it.
	const outsider = await login((await createPlantManager((await createArea()).plantId)).email);
	expect((await outsider.get(page)).status()).toBe(404);
	expect(
		await action(outsider, '/plant-manager/attendance/correct?/correct', {
			...form,
			reason: 'Trying from another plant'
		})
	).toMatchObject({ type: 'failure', status: 404 });
});

test('CORR-02 the admin can mark both halves when the day has only one photo', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const sessionId = await recordSession(await login(pump.email), ['CORR02']);
	const [person] = await personIds(sessionId);
	const day = await sessionDay(sessionId);
	const admin = await login((await createAdmin()).email);
	expect(
		await action(admin, `/admin/attendance/correct?/correct&pump=${pump.id}&day=${day}`, {
			person_id: person,
			pump_id: pump.id,
			day,
			morning_present: 'on',
			evening_present: 'on',
			reason: 'Missed shift start, confirmed by plant'
		})
	).toMatchObject({ type: 'success' });
	const { rows } = await db.query(
		`SELECT evening_matched FROM daily_person_attendance WHERE person_id = $1 AND session_date = $2`,
		[person, day]
	);
	expect(rows[0].evening_matched).toBe(true);
	const { rows: history } = await db.query(
		'SELECT corrected_by_admin_id IS NOT NULL AS by_admin FROM attendance_corrections WHERE person_id = $1',
		[person]
	);
	expect(history).toEqual([{ by_admin: true }]);
});

test('UI-10 session logs show fraud faces inline and load other faces on click', async () => {
	const { plantId } = await createArea();
	const vendor = await createVendor();
	const a = await createPump(plantId, vendor.id);
	const b = await createPump(plantId);
	const manager = await login((await createPlantManager(plantId)).email);
	const counted = await recordSession(await login(a.email), ['UI10F', 'UI10W']);
	const flagged = await submitAndWait(await login(b.email), ['UI10F']);
	// The stub AI returns no crops; give the counted workers and the fraud flag distinct ones.
	const workerCrop = 'data:image/jpeg;base64,V09SS0VSQ1JPUA==';
	const fraudCrop = 'data:image/jpeg;base64,RlJBVURDUk9Q';
	await db.query('UPDATE attendance_face_evidence SET face_crop_url = $2 WHERE session_id = $1', [
		counted,
		workerCrop
	]);
	await db.query(
		'UPDATE person_face_vectors SET source_photo_crop_url = $2 WHERE session_id = $1',
		[counted, workerCrop]
	);
	await db.query('UPDATE fraud_flags SET face_crop_url = $2 WHERE session_id = $1', [
		flagged,
		fraudCrop
	]);

	// Fraud: the face is on screen. Counted workers: a chip, the face loads when opened.
	const log = await (await manager.get('/plant-manager/attendance')).text();
	expect(log).toContain('data-testid="fraud-face"');
	expect(log).toContain(fraudCrop);
	// Each fraud tile names the worker it matched, so several tiles can be told apart.
	expect(log).toMatch(
		/data-testid="fraud-face"[\s\S]*?class="face-tile__who[^"]*">Test Worker \d+ \(#\d+\)</
	);
	expect(log).toContain('data-testid="worker-chip"');
	expect(log).not.toContain(workerCrop);
	const faceUrl = log.match(/\/api\/attendance\/face\/[0-9a-f-]{36}/)![0];
	const image = await manager.get(faceUrl);
	expect(image.status()).toBe(200);
	expect(image.headers()['content-type']).toBe('image/jpeg');
	expect((await image.body()).toString()).toBe('WORKERCROP');

	// The vendor of the pump may open it too (bug 2026-10-22: the API guard refused managers).
	expect((await (await login(vendor.email)).get(faceUrl)).status()).toBe(200);

	// The People page face works the same way, for the same plant only.
	const [person] = await personIds(counted);
	expect((await manager.get(`/api/persons/${person}/face`)).status()).toBe(200);
	const outsider = await login((await createPlantManager((await createArea()).plantId)).email);
	expect((await outsider.get(faceUrl)).status()).toBe(404);
	expect((await outsider.get(`/api/persons/${person}/face`)).status()).toBe(404);
});

test('UI-11 the session log shows one numbered row per shift, start and end together', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const manager = await login((await createPlantManager(plantId)).email);
	const context = await login(pump.email);
	const start = await recordSession(context, ['UI11A']);
	await shiftBack(start, 600);
	await recordSession(context, ['UI11A']);

	const log = await (await manager.get('/plant-manager/attendance')).text();
	const rows = log.split('data-testid="shift-row"').slice(1);
	// Two photos, one shift: a single row holding both halves, numbered 1, under one date heading.
	expect(rows).toHaveLength(1);
	expect(rows[0]).toContain('Shift start');
	expect(rows[0]).toContain('Shift end');
	expect(rows[0]).toContain('Full shift');
	expect(rows[0]).toMatch(/class="shift__number[^"]*"[^>]*>1</);
	expect(log.match(/class="log-day__title/g)).toHaveLength(1);
});

test('UI-12 the admin pump page shows the same shift rows, with the admin tools on each photo', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const admin = await login((await createAdmin()).email);
	const context = await login(pump.email);
	const start = await recordSession(context, ['UI12A']);
	await shiftBack(start, 600);
	await recordSession(context, ['UI12A']);
	// More workers than one roster page (25), so the page renders its pager on the server: it
	// used to read window and fail with a 500.
	await db.query(
		`INSERT INTO persons (pump_id, display_seq, name)
		 SELECT $1, 100 + n, 'Pager Worker ' || n FROM generate_series(1, 26) n`,
		[pump.id]
	);

	const response = await admin.get(`/admin/pumps/${pump.id}`);
	expect(response.status()).toBe(200);
	const page = await response.text();
	const rows = page.split('data-testid="shift-row"').slice(1);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toContain('Full shift');
	expect(rows[0]).toMatch(/class="shift__number[^"]*"[^>]*>1</);
	// Both photos keep Delete / reset and Fix shift; Fix attendance opens the admin correction.
	expect(rows[0].match(/Delete \/ reset/g)).toHaveLength(2);
	expect(rows[0].match(/data-testid="shift-fix"/g)).toHaveLength(2);
	expect(rows[0]).toContain(`/admin/attendance/correct?pump=${pump.id}`);
	expect(page).toMatch(/Page 1 of 2/);
});
