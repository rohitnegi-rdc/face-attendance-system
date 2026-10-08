// AUTH and RBAC scenarios from plans/RegressionTestPlan.md.
import { expect, test } from '@playwright/test';
import {
	PASSWORD,
	anonymous,
	createAdmin,
	createArea,
	createPlantManager,
	createPump,
	createVendor,
	db,
	login,
	photo,
	submit,
	waitForSession
} from './helpers';

test('AUTH-01 every role logs in and gets its own role back', async () => {
	const { plantId } = await createArea();
	const accounts = {
		admin: (await createAdmin()).email,
		vendor: (await createVendor()).email,
		'plant-manager': (await createPlantManager(plantId)).email,
		pump: (await createPump(plantId)).email
	};
	for (const [role, email] of Object.entries(accounts)) {
		const context = await anonymous();
		const response = await context.post('/api/auth/login', { data: { email, password: PASSWORD } });
		expect(response.status(), role).toBe(200);
		expect((await response.json()).role).toBe(role);
	}
});

test('AUTH-02 wrong password, unknown email and empty fields are rejected without enumeration', async () => {
	const admin = await createAdmin();
	const context = await anonymous();
	const wrong = await context.post('/api/auth/login', {
		data: { email: admin.email, password: 'nope' }
	});
	const unknown = await context.post('/api/auth/login', {
		data: { email: 'nobody@regression.test', password: 'nope' }
	});
	const empty = await context.post('/api/auth/login', { data: { email: '', password: '' } });
	expect(wrong.status()).toBe(401);
	expect(unknown.status()).toBe(401);
	expect(await wrong.json()).toEqual(await unknown.json());
	expect(empty.status()).toBe(400);
});

test('AUTH-03 email is case-insensitive', async () => {
	const admin = await createAdmin();
	await login(admin.email.toUpperCase());
});

test('AUTH-04/05 a disabled pump cannot log in, and an existing token cannot submit', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const context = await login(pump.email);
	await db.query(`UPDATE pumps SET status = 'disabled', disabled_at = now() WHERE id = $1`, [
		pump.id
	]);

	const retryLogin = await (
		await anonymous()
	).post('/api/auth/login', {
		data: { email: pump.email, password: PASSWORD }
	});
	expect(retryLogin.status()).toBe(403);

	const submitted = await submit(context, await photo(['AUTH05']));
	expect(submitted.status).toBe(403);
	const { rows } = await db.query('SELECT 1 FROM attendance_sessions WHERE pump_id = $1', [
		pump.id
	]);
	expect(rows).toHaveLength(0);
});

test('AUTH-06/07 first login is forced through a password change', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	await db.query('UPDATE pumps SET must_change_password = TRUE WHERE id = $1', [pump.id]);
	const context = await login(pump.email);

	const page = await context.get('/pump', { maxRedirects: 0 });
	expect(page.status()).toBe(302);
	expect(page.headers().location).toContain('/change-password');
	expect((await context.get('/api/attendance/today')).status()).toBe(403);

	const short = await context.post('/api/auth/password', {
		data: { password: 'short', confirmation: 'short' }
	});
	expect(short.status()).toBe(400);
	const mismatch = await context.post('/api/auth/password', {
		data: { password: 'Long-enough-pass-1', confirmation: 'Long-enough-pass-2' }
	});
	expect(mismatch.status()).toBe(400);
	const changed = await context.post('/api/auth/password', {
		data: { password: 'Long-enough-pass-1', confirmation: 'Long-enough-pass-1' }
	});
	expect(changed.status()).toBe(200);
	expect((await context.get('/api/attendance/today')).status()).toBe(200);
	await login(pump.email, 'Long-enough-pass-1');
});

test('AUTH-09 a tampered session cookie counts as logged out', async () => {
	const context = await anonymous();
	const response = await context.get('/admin', {
		maxRedirects: 0,
		headers: { cookie: 'session_http=eyJhbGciOiJIUzI1NiJ9.e30.forged' }
	});
	expect(response.status()).toBe(302);
	expect(response.headers().location).toContain('/login');
});

test('RBAC-01 each role reaches only its own pages; anonymous users go to login', async () => {
	const { plantId } = await createArea();
	const contexts = {
		admin: await login((await createAdmin()).email),
		vendor: await login((await createVendor()).email),
		'plant-manager': await login((await createPlantManager(plantId)).email),
		pump: await login((await createPump(plantId)).email)
	};
	const pages = ['/admin', '/vendor', '/plant-manager', '/pump'];
	for (const [role, context] of Object.entries(contexts)) {
		for (const path of pages) {
			const status = (await context.get(path, { maxRedirects: 0 })).status();
			expect(status, `${role} -> ${path}`).toBe(path === `/${role}` ? 200 : 403);
		}
	}
	const anon = await anonymous();
	for (const path of pages) {
		expect((await anon.get(path, { maxRedirects: 0 })).status(), `anonymous -> ${path}`).toBe(302);
	}
});

test('RBAC-02 admin and attendance APIs reject the wrong role', async () => {
	const { plantId } = await createArea();
	const anon = await anonymous();
	const vendor = await login((await createVendor()).email);
	const pump = await login((await createPump(plantId)).email);
	const manager = await login((await createPlantManager(plantId)).email);
	const admin = await login((await createAdmin()).email);

	expect((await anon.get('/api/admin/attendance/export')).status()).toBe(401);
	expect((await vendor.get('/api/admin/attendance/export')).status()).toBe(403);
	expect((await pump.get('/api/admin/attendance/export')).status()).toBe(403);
	expect((await admin.get('/api/admin/attendance/export')).status()).toBe(200);
	expect((await vendor.get('/api/attendance/today')).status()).toBe(403);
	expect(
		(await submit(manager, await photo(['RBAC02']))).status,
		'plant manager must not submit attendance'
	).toBe(403);
});

test('RBAC-03/04 a pump cannot read, approve or retry another pump’s session', async () => {
	const { plantId } = await createArea();
	const pumpA = await login((await createPump(plantId)).email);
	const pumpB = await login((await createPump(plantId)).email);
	const submitted = await submit(pumpA, await photo(['RBAC03']));
	expect(submitted.status).toBe(202);
	const sessionId = submitted.body.session_id;
	await waitForSession(sessionId, ['review']);

	expect((await pumpB.get(`/api/attendance/status/${sessionId}`)).status()).toBe(403);
	expect((await pumpB.get(`/api/attendance/photo/${sessionId}`)).status()).toBe(403);
	expect((await pumpB.post(`/api/attendance/approve/${sessionId}`)).status()).toBe(403);
	expect((await pumpB.post(`/api/attendance/retry/${sessionId}`)).status()).toBe(403);
	const { rows } = await db.query('SELECT status FROM attendance_sessions WHERE id = $1', [
		sessionId
	]);
	expect(rows[0].status).toBe('review');
});

test('RBAC-05 a plant manager cannot see a photo from a plant they do not manage', async () => {
	const own = await createArea();
	const other = await createArea();
	const manager = await login((await createPlantManager(own.plantId)).email);
	const otherPump = await login((await createPump(other.plantId)).email);
	const submitted = await submit(otherPump, await photo(['RBAC05']));
	expect(submitted.status).toBe(202);
	expect((await manager.get(`/api/attendance/photo/${submitted.body.session_id}`)).status()).toBe(
		403
	);
});

test('RBAC-07 a vendor sees only its own pumps', async () => {
	const { plantId } = await createArea();
	const vendorA = await createVendor();
	const vendorB = await createVendor();
	const pumpA = await createPump(plantId, vendorA.id);
	const pumpB = await createPump(plantId, vendorB.id);
	const html = await (await (await login(vendorA.email)).get('/vendor/pumps')).text();
	expect(html).toContain(pumpA.code);
	expect(html).not.toContain(pumpB.code);
});

test('RBAC-09 a vendor cannot run admin actions', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const vendor = await login((await createVendor()).email);
	const response = await vendor.post(`/admin/pumps/${pump.id}?/clearPumpData`, {
		form: { confirm_code: pump.code }
	});
	expect(response.status()).toBe(403);
	const settings = await vendor.post('/admin/settings?/save', {
		form: { evening_min_gap_minutes: '1', evening_pairing_window_hours: '2' }
	});
	expect(settings.status()).toBe(403);
});
