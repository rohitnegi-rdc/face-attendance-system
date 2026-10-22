// LOC: shift start location check. In an area with the check on, the operator's phone must be
// within 100 m of the pump's latest GPS reading (at most 30 minutes old). Otherwise the shift
// starts on hold, the plant manager approves or rejects it on /plant-manager/approvals, and the
// reports leave the day out until it is approved.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type APIRequestContext } from '@playwright/test';
import ExcelJS from 'exceljs';
import {
	approve,
	action,
	anonymous,
	BASE_URL,
	createArea,
	createPlantManager,
	createPump,
	db,
	defaultOperatorPhoto,
	login,
	photo,
	waitForSession,
	type Pump
} from './helpers';

// A point in Mumbai and points ~40 m and ~520 m north of it.
const PUMP = { lat: 19.0596, lng: 72.9165 };
const NEAR = { lat: 19.05996, lng: 72.9165 };
const FAR = { lat: 19.06428, lng: 72.9165 };

async function checkedArea() {
	const area = await createArea();
	await db.query('UPDATE areas SET location_check_enabled = true WHERE id = $1', [area.areaId]);
	return area;
}

async function setPumpGps(pump: Pump, minutesAgo = 1, at = PUMP) {
	await db.query(
		`INSERT INTO pump_locations (pump_id, lat, lng, recorded_at, source)
		 VALUES ($1, $2, $3, now() - make_interval(mins => $4), 'gps_api')`,
		[pump.id, at.lat, at.lng, minutesAgo]
	);
}

async function startShift(
	context: APIRequestContext,
	phone: { lat: number; lng: number } | null,
	faces = ['loc-a']
) {
	const group = await photo(faces);
	const multipart: Record<string, any> = {
		photo: { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: group },
		operator_photo: {
			name: 'operator.jpg',
			mimeType: 'image/jpeg',
			buffer: await defaultOperatorPhoto(group)
		}
	};
	if (phone) {
		multipart.lat = String(phone.lat);
		multipart.lng = String(phone.lng);
	}
	const response = await context.post('/api/attendance/submit', { multipart });
	const body = await response.json();
	expect(response.status(), JSON.stringify(body)).toBe(202);
	const session = await waitForSession(body.session_id, ['review']);
	await approve(context, body.session_id);
	return { body, session };
}

async function dailyRowsFor(context: APIRequestContext, pumpCode: string) {
	const response = await context.get('/plant-manager/attendance/export');
	expect(response.status()).toBe(200);
	const book = new ExcelJS.Workbook();
	await book.xlsx.load((await response.body()) as any);
	const ws = book.getWorksheet('Daily')!;
	const header = (ws.getRow(1).values as any[]).slice(1);
	const pumpCol = header.indexOf('Pump') + 1;
	let n = 0;
	ws.eachRow((row, i) => {
		if (i > 1 && row.getCell(pumpCol).value === pumpCode) n += 1;
	});
	return n;
}

test('LOC-01 area without the check: no location status at all', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const { body, session } = await startShift(await login(pump.email), null);
	expect(body.location_hold).toBeNull();
	expect(session.location_status).toBeNull();
});

test('LOC-02 within 100 m of fresh pump GPS starts normally', async () => {
	const { plantId } = await checkedArea();
	const pump = await createPump(plantId);
	await setPumpGps(pump);
	const { body, session } = await startShift(await login(pump.email), NEAR);
	expect(body.location_hold).toBeNull();
	expect(session.location_status).toBe('ok');
	expect(session.location_distance_m).toBeLessThanOrEqual(100);
});

test('LOC-03 each missing or failed check is held with its own reason', async () => {
	const cases: { issue: string; phone: typeof PUMP | null; gpsMinutesAgo: number | null }[] = [
		{ issue: 'too_far', phone: FAR, gpsMinutesAgo: 1 },
		{ issue: 'no_phone_location', phone: null, gpsMinutesAgo: 1 },
		{ issue: 'no_pump_gps', phone: NEAR, gpsMinutesAgo: null },
		{ issue: 'stale_pump_gps', phone: NEAR, gpsMinutesAgo: 45 }
	];
	for (const c of cases) {
		const { plantId } = await checkedArea();
		const pump = await createPump(plantId);
		if (c.gpsMinutesAgo !== null) await setPumpGps(pump, c.gpsMinutesAgo);
		const { body, session } = await startShift(await login(pump.email), c.phone);
		expect(session.location_status, c.issue).toBe('pending');
		expect(session.location_issue, c.issue).toBe(c.issue);
		expect(body.location_hold, c.issue).toBeTruthy();
		if (c.issue === 'too_far') {
			expect(session.location_distance_m).toBeGreaterThan(400);
			expect(body.location_hold).toContain(`${session.location_distance_m} m`);
		}
		// The shift still started: the morning row exists and is open for the end photo.
		expect(session.pairing_status).toBe('open');
	}
});

test('LOC-04 plant manager approves; held day is left out of the report until then', async () => {
	const { plantId } = await checkedArea();
	const pump = await createPump(plantId);
	await setPumpGps(pump);
	const manager = await createPlantManager(plantId);
	const { session } = await startShift(await login(pump.email), FAR, ['loc-b', 'loc-c']);
	const pm = await login(manager.email);

	const list = await pm.get('/plant-manager/approvals');
	expect(await list.text()).toContain(pump.code);
	const page = await pm.get(`/plant-manager/approvals/${session.id}`);
	expect(page.status()).toBe(200);

	expect(await dailyRowsFor(pm, pump.code)).toBe(0);
	const approved = await action(pm, `/plant-manager/approvals/${session.id}?/approve`, {
		note: 'Called operator, new site'
	});
	expect(approved.type, JSON.stringify(approved)).toBe('success');
	const { rows } = await db.query('SELECT * FROM attendance_sessions WHERE id = $1', [session.id]);
	expect(rows[0].location_status).toBe('approved');
	expect(rows[0].location_decided_by).toBe(manager.id);
	expect(await dailyRowsFor(pm, pump.code)).toBe(2);

	// A second decision is refused, not silently overwritten.
	const again = await action(pm, `/plant-manager/approvals/${session.id}?/reject`, { note: 'x' });
	expect(again.status).toBe(409);
});

test('LOC-05 reject needs a note and keeps the day out of the report', async () => {
	const { plantId } = await checkedArea();
	const pump = await createPump(plantId);
	const manager = await createPlantManager(plantId);
	const { session } = await startShift(await login(pump.email), null);
	const pm = await login(manager.email);

	const noNote = await action(pm, `/plant-manager/approvals/${session.id}?/reject`, { note: '' });
	expect(noNote.status).toBe(400);
	const rejected = await action(pm, `/plant-manager/approvals/${session.id}?/reject`, {
		note: 'Operator was at home'
	});
	expect(rejected.type).toBe('success');
	expect(await dailyRowsFor(pm, pump.code)).toBe(0);
});

test('LOC-06 only the plant manager of that plant sees it; login returns to the link', async () => {
	const { plantId } = await checkedArea();
	const pump = await createPump(plantId);
	const { session } = await startShift(await login(pump.email), null);
	const other = await createPlantManager((await createArea()).plantId);
	const stranger = await login(other.email);
	expect((await stranger.get(`/plant-manager/approvals/${session.id}`)).status()).toBe(404);
	const denied = await action(stranger, `/plant-manager/approvals/${session.id}?/approve`, {
		note: ''
	});
	expect(denied.httpStatus).toBe(404);

	const anon = await anonymous();
	const redirect = await anon.get(`/plant-manager/approvals/${session.id}`, { maxRedirects: 0 });
	expect(redirect.status()).toBe(302);
	expect(redirect.headers().location).toContain(
		`next=${encodeURIComponent(`/plant-manager/approvals/${session.id}`)}`
	);
});

// JSON log lines of a service started by scripts/run-regression.mjs that contain every `texts`.
async function logLines(service: string, texts: string | string[], timeoutMs = 10_000) {
	const all = [texts].flat();
	const file = path.join(process.env.REGRESSION_OUTPUT_DIR ?? '', `${service}.log`);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const lines = fs.existsSync(file)
			? fs
					.readFileSync(file, 'utf8')
					.split('\n')
					.filter((l) => all.every((t) => l.includes(t)))
			: [];
		if (lines.length) return lines.map((l) => JSON.parse(l.slice(l.indexOf('{'))));
		if (Date.now() >= deadline) return [];
		await new Promise((r) => setTimeout(r, 250));
	}
}

test('LOC-07 held shift emails the plant manager an absolute approval link', async () => {
	test.skip(!process.env.REGRESSION_OUTPUT_DIR, 'needs the app log from run-regression');
	const { plantId } = await checkedArea();
	const pump = await createPump(plantId);
	const manager = await createPlantManager(plantId);
	const { session } = await startShift(await login(pump.email), null);

	const mails = await logLines('app', [session.id, 'location approval email']);
	expect(mails).toHaveLength(1);
	const [mail] = mails;
	expect(mail.message).toBe('location approval email NOT sent (MAIL_LOG_ONLY)');
	expect(mail.to).toEqual([manager.email]);
	expect(mail.subject).toContain(pump.code);
	// Regression: the link was once built as "<origin>../../plant-manager/...".
	expect(mail.approvalUrl).toBe(`${BASE_URL}/plant-manager/approvals/${session.id}`);
});

test('LOC-08 worker copies pump GPS from the feed, by pump code or GPS device id', async () => {
	test.skip(!process.env.REGRESSION_OUTPUT_DIR, 'needs the workers from run-regression');
	const { plantId } = await checkedArea();
	const byCode = await createPump(plantId);
	const byDevice = await createPump(plantId);
	const deviceId = `DEV-${byDevice.code}`;
	await db.query('UPDATE pumps SET gps_device_id = $1 WHERE id = $2', [deviceId, byDevice.id]);
	const unknown = `UNKNOWN-${byCode.code}`;

	const feed = (id: string, lat: string, lng: string, minutesAgo: number) =>
		db.query(
			`INSERT INTO dump.pump_events (pump_id, latitude, longitude, event_timestamp)
			 VALUES ($1, $2, $3, date_trunc('second', now()) - make_interval(mins => $4))`,
			[id, lat, lng, minutesAgo]
		);
	await feed(byCode.code.toLowerCase(), String(PUMP.lat), String(PUMP.lng), 2); // case-insensitive
	await feed(byCode.code, '', '', 1); // no fix: skipped
	await feed(byCode.code, '19.1', '72.9', 180); // older than the lookback: skipped
	await feed(deviceId, '19.0601', '72.9170', 3);
	await feed(unknown, '19.0', '72.9', 1);

	const rowsFor = async (pumpId: string) =>
		(
			await db.query(
				`SELECT lat, lng, source, now() - recorded_at AS age FROM pump_locations WHERE pump_id = $1`,
				[pumpId]
			)
		).rows;
	await expect.poll(async () => (await rowsFor(byCode.id)).length, { timeout: 20_000 }).toBe(1);
	await expect.poll(async () => (await rowsFor(byDevice.id)).length, { timeout: 20_000 }).toBe(1);
	const [reading] = await rowsFor(byCode.id);
	expect(reading.lat).toBe(PUMP.lat);
	expect(reading.lng).toBe(PUMP.lng);
	expect(reading.source).toBe('gps_api');
	expect((await rowsFor(byDevice.id))[0].lat).toBe(19.0601);
	// The unknown id is logged by whichever worker polled.
	await expect
		.poll(
			async () =>
				(await logLines('worker-1', unknown, 0)).length +
				(await logLines('worker-2', unknown, 0)).length,
			{ timeout: 20_000 }
		)
		.toBeGreaterThan(0);

	// The copied reading drives the check: the operator nearby starts normally.
	const { session } = await startShift(await login(byCode.email), NEAR);
	expect(session.location_status).toBe('ok');
});
