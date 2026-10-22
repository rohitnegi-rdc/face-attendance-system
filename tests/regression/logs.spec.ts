// LOG: central log. Warnings and errors from the app and the worker land in system_logs and show
// on /admin/logs (admin only); one photo's lines are found by its request id.
import { test, expect } from '@playwright/test';
import {
	createAdmin,
	createArea,
	createPlantManager,
	createPump,
	db,
	login,
	photo,
	submit,
	waitForSession
} from './helpers';

// Lines are stored without blocking the request, so wait for them.
async function waitForLog(where: string, params: unknown[], timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { rows } = await db.query(`SELECT * FROM system_logs WHERE ${where}`, params);
		if (rows.length) return rows;
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`no system_logs line for ${where} ${JSON.stringify(params)}`);
}

test('LOG-01 a failed photo is logged by the worker and traced on the admin Logs page', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const context = await login(pump.email);
	const submitted = await submit(context, await photo(['LOG01']), 'image/jpeg', await photo([]));
	expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
	const session = await waitForSession(submitted.body.session_id, ['failed', 'review']);
	expect(session.status).toBe('failed');

	const requestId = submitted.body.request_id as string;
	const [line] = await waitForLog('request_id = $1 AND service = $2', [requestId, 'worker']);
	expect(line.level).toBe('error');
	expect(line.message).toBe('session failed');
	expect(line.session_id).toBe(session.id);

	const admin = await login((await createAdmin()).email);
	const page = await admin.get(`/admin/logs?days=1&q=${requestId}`);
	expect(page.status()).toBe(200);
	const list = (await page.text()).split('data-testid="log-list"')[1] ?? '';
	expect(list).toContain('session failed');
	expect(list).toContain(pump.code);
});

test('LOG-02 an unhandled app error is logged with its path and is searchable', async () => {
	const admin = await login((await createAdmin()).email);
	const marker = `not-a-valid-id-${Date.now()}`;
	expect((await admin.get(`/admin/pumps/${marker}`)).status()).toBe(500);

	const [line] = await waitForLog(`service = 'app' AND details->>'path' LIKE $1`, [`%${marker}`]);
	expect(line.level).toBe('error');
	expect(line.details.errorId).toMatch(/^[0-9a-f]{8}$/);

	// The search box repeats the query, so look only inside the results list.
	const results = (html: string) => html.split('data-testid="log-list"')[1] ?? '';
	const errors = await (await admin.get(`/admin/logs?days=1&level=error&q=${marker}`)).text();
	expect(results(errors)).toContain(marker);
	// Filters work: the same search among warnings only finds nothing.
	const warnings = await (await admin.get(`/admin/logs?days=1&level=warn&q=${marker}`)).text();
	expect(results(warnings)).toBe('');
});

test('LOG-03 only the admin can open the Logs page', async () => {
	const { plantId } = await createArea();
	const pump = await login((await createPump(plantId)).email);
	const manager = await login((await createPlantManager(plantId)).email);
	expect((await pump.get('/admin/logs', { maxRedirects: 0 })).status()).toBe(403);
	expect((await manager.get('/admin/logs', { maxRedirects: 0 })).status()).toBe(403);
});
