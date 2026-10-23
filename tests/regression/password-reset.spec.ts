// PWD: forgot password and resets by someone else. The email link (/forgot-password, then
// /reset-password) works once for 30 minutes; the page answers the same for unknown emails; logins
// made by the system (.rdc) have no mailbox and are sent to the plant manager or the admin, who
// issue a temporary password the user must replace at sign-in.
import { createHash } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
	action,
	anonymous,
	BASE_URL,
	count,
	createAdmin,
	createArea,
	createPlantManager,
	createPump,
	db,
	login,
	logLines,
	PASSWORD
} from './helpers';

const NEW_PASSWORD = 'Brand-New-Pass-456';

async function signIn(email: string, password: string) {
	const response = await (await anonymous()).post('/api/auth/login', { data: { email, password } });
	return { status: response.status(), body: await response.json().catch(() => ({})) };
}

// The one-time credentials a reset shows, read from the rendered page.
async function temporaryPassword(
	context: APIRequestContext,
	path: string,
	id: string,
	testId: string
) {
	const response = await context.post(path, { form: { id } });
	const html = await response.text();
	const block = html.split(`data-testid="${testId}"`)[1] ?? '';
	const codes = [...block.matchAll(/<code[^>]*>([^<]+)<\/code>/g)].map((m) => m[1]);
	return { status: response.status(), email: codes[0], password: codes[1] };
}

async function managerWithMailbox() {
	const { plantId } = await createArea();
	return { plantId, ...(await createPlantManager(plantId)) };
}

test('PWD-01 the emailed link sets a new password once, then stops working', async () => {
	test.skip(!process.env.REGRESSION_OUTPUT_DIR, 'needs the app log from run-regression');
	const manager = await managerWithMailbox();
	const anon = await anonymous();

	const asked = await action(anon, '/forgot-password', { email: manager.email.toUpperCase() });
	expect(asked.type).toBe('success');
	const [mail] = await logLines('app', ['password reset email NOT sent', manager.email]);
	expect(mail.to).toBe(manager.email);
	expect(mail.link).toMatch(new RegExp(`^${BASE_URL}/reset-password\\?token=[\\w-]{40,}$`));
	const token = new URL(mail.link).searchParams.get('token')!;

	const page = await (await anon.get(mail.link)).text();
	expect(page).toContain(manager.email);
	expect(page).not.toContain('data-testid="reset-expired"');

	// A typo keeps the link usable.
	const typo = await action(anon, '/reset-password', {
		token,
		password: NEW_PASSWORD,
		confirmation: 'something-else-entirely'
	});
	expect(typo.status).toBe(400);

	const saved = await action(anon, '/reset-password', {
		token,
		password: NEW_PASSWORD,
		confirmation: NEW_PASSWORD
	});
	expect(saved.type).toBe('redirect');
	expect((await signIn(manager.email, NEW_PASSWORD)).status).toBe(200);
	expect((await signIn(manager.email, PASSWORD)).status).toBe(401);

	// Used once: the same link shows the expired page and refuses a second password.
	expect(await (await anon.get(mail.link)).text()).toContain('data-testid="reset-expired"');
	const again = await action(anon, '/reset-password', {
		token,
		password: 'Another-Pass-789x',
		confirmation: 'Another-Pass-789x'
	});
	expect(again.status).toBe(410);
	expect(
		await count(
			`SELECT 1 FROM password_reset_log WHERE account_id = $1 AND method = 'email_link'`,
			[manager.id]
		)
	).toBe(1);
});

test('PWD-02 an unknown email gets the same answer and no email', async () => {
	test.skip(!process.env.REGRESSION_OUTPUT_DIR, 'needs the app log from run-regression');
	const email = `nobody-${Date.now()}@regression.test`;
	const html = await (
		await (await anonymous()).post('/forgot-password', { form: { email } })
	).text();
	expect(html).toContain('data-testid="reset-sent"');
	expect(html).toContain('data-testid="reset-help"');
	expect(await logLines('app', ['password reset email', email], 1_500)).toEqual([]);
});

test('PWD-03 a system login (.rdc) is told who can reset it; no link is made', async () => {
	const before = await count('SELECT 1 FROM password_reset_tokens');
	const anon = await anonymous();
	const vendor = await (
		await anon.post('/forgot-password', { form: { email: 'vendor01@vendors.rdc' } })
	).text();
	expect(vendor).toContain('data-testid="reset-no-mailbox"');
	expect(vendor).toContain('your plant manager, or the admin');
	const pump = await (
		await anon.post('/forgot-password', { form: { email: 'pump01@pumps.rdc' } })
	).text();
	expect(pump).toContain('data-testid="reset-pump"');
	expect(await count('SELECT 1 FROM password_reset_tokens')).toBe(before);
});

test('PWD-07 a pump login is never reset by email, even with a real-looking address', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	expect(pump.email).not.toMatch(/\.rdc$/);
	const form = await (await (await anonymous()).get('/forgot-password')).text();
	expect(form).toContain('data-testid="forgot-pump-note"');
	const html = await (
		await (await anonymous()).post('/forgot-password', { form: { email: pump.email } })
	).text();
	expect(html).toContain('data-testid="reset-pump"');
	expect(html).toContain('plant manager');
	expect(
		await count('SELECT 1 FROM password_reset_tokens WHERE role = $1 AND account_id = $2', [
			'pump',
			pump.id
		])
	).toBe(0);
});

test('PWD-04 an expired or made-up link shows "no longer works"', async () => {
	const manager = await managerWithMailbox();
	const token = 'expired-token-' + Date.now();
	await db.query(
		`INSERT INTO password_reset_tokens (role, account_id, token_hash, expires_at)
		 VALUES ('plant-manager', $1, $2, now() - interval '1 minute')`,
		[manager.id, createHash('sha256').update(token).digest('hex')]
	);
	const anon = await anonymous();
	for (const t of [token, 'made-up']) {
		expect(await (await anon.get(`/reset-password?token=${t}`)).text()).toContain(
			'data-testid="reset-expired"'
		);
	}
	const refused = await action(anon, '/reset-password', {
		token,
		password: NEW_PASSWORD,
		confirmation: NEW_PASSWORD
	});
	expect(refused.status).toBe(410);
	expect((await signIn(manager.email, PASSWORD)).status).toBe(200);
});

test('PWD-05 a plant manager resets a pump of their own plant, not of another', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const manager = await login((await createPlantManager(plantId)).email);
	const { plantId: otherPlant } = await createArea();
	const otherPump = await createPump(otherPlant);

	const issued = await temporaryPassword(
		manager,
		'/plant-manager/pumps?/resetPumpPassword',
		pump.id,
		'pump-temp-password'
	);
	expect(issued.email).toBe(pump.email);
	const signedIn = await signIn(pump.email, issued.password);
	expect(signedIn.status).toBe(200);
	expect(signedIn.body.mustChangePassword).toBe(true);
	expect(
		await count(
			`SELECT 1 FROM password_reset_log WHERE account_id = $1 AND by_role = 'plant-manager'`,
			[pump.id]
		)
	).toBe(1);

	const refused = await action(manager, '/plant-manager/pumps?/resetPumpPassword', {
		id: otherPump.id
	});
	expect(refused.status).toBe(404);
	expect((await signIn(otherPump.email, PASSWORD)).status).toBe(200);
});

test('PWD-06 the admin resets a plant manager; an open email link stops working', async () => {
	const manager = await managerWithMailbox();
	const admin = await login((await createAdmin()).email);
	const token = 'open-link-' + Date.now();
	await db.query(
		`INSERT INTO password_reset_tokens (role, account_id, token_hash, expires_at)
		 VALUES ('plant-manager', $1, $2, now() + interval '30 minutes')`,
		[manager.id, createHash('sha256').update(token).digest('hex')]
	);

	const issued = await temporaryPassword(
		admin,
		'/admin/plant-managers?/resetManagerPassword',
		manager.id,
		'manager-temp-password'
	);
	expect(issued.email).toBe(manager.email);
	const signedIn = await signIn(manager.email, issued.password);
	expect(signedIn.status).toBe(200);
	expect(signedIn.body.mustChangePassword).toBe(true);
	expect(await (await (await anonymous()).get(`/reset-password?token=${token}`)).text()).toContain(
		'data-testid="reset-expired"'
	);
});
