import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
	connectionString:
		process.env.DATABASE_URL || 'postgres://attendance:attendance@127.0.0.1:6101/attendance'
});
const baseUrl = process.env.ANTI_SPOOF_E2E_BASE_URL || 'https://127.0.0.1:3443';
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
const output = path.resolve('test-output', 'anti-spoofing', new Date().toISOString().replace(/[:.]/g, '-'));

let pump: { id: string; login_email: string; pump_code: string };
let sessionId = '';

async function authenticate(page: Page) {
	const token = jwt.sign({ role: 'pump', id: pump.id, email: pump.login_email }, jwtSecret, {
		expiresIn: '1h'
	});
	await page.context().addCookies([
		{ name: 'session', value: token, url: baseUrl, httpOnly: true, sameSite: 'Lax' }
	]);
}

test.beforeAll(async () => {
	await fs.mkdir(output, { recursive: true });
	const tag = `${test.info().project.name.replace(/\W/g, '')}${Date.now().toString().slice(-6)}`;
	const area = await pool.query(`INSERT INTO areas (name) VALUES ($1) RETURNING id`, [`Anti-spoof ${tag}`]);
	const plant = await pool.query(`INSERT INTO plants (area_id, name) VALUES ($1, $2) RETURNING id`, [area.rows[0].id, `Anti-spoof plant ${tag}`]);
	const vendor = await pool.query(`INSERT INTO vendors (name, email, password_hash) VALUES ($1, $2, 'unused') RETURNING id`, [`Anti-spoof vendor ${tag}`, `anti-${tag}@e2e.local`]);
	const created = await pool.query(
		`INSERT INTO pumps (plant_id, vendor_id, pump_code, login_email, password_hash)
		 VALUES ($1, $2, $3, $4, 'unused') RETURNING id, login_email, pump_code`,
		[plant.rows[0].id, vendor.rows[0].id, `ANTI${tag}`, `anti-pump-${tag}@e2e.local`]
	);
	pump = created.rows[0];
});

test.afterAll(async () => {
	await pool.end();
});

test('mixed liveness state is understandable and remains reviewable', async ({ page }, testInfo) => {
	await authenticate(page);
	await page.goto('/pump');
	console.log(`anti-spoof browser reached ${page.url()}`);
	await expect(page).toHaveURL(/\/pump$/);
	const fixture = Buffer.concat([
		await fs.readFile('tests/fixtures/group-e2e/photos/a-01-baseline.jpg'),
		Buffer.from(`\nANTI-SPOOF-E2E:${pump.id}\n`)
	]);
	const submission = await page.evaluate(async (photoBase64) => {
		const bytes = Uint8Array.from(atob(photoBase64), (character) => character.charCodeAt(0));
		const form = new FormData();
		form.append('photo', new File([bytes], 'anti-spoof-camera.jpg', { type: 'image/jpeg' }));
		const response = await fetch('/api/attendance/submit', { method: 'POST', body: form });
		return { status: response.status, body: await response.text() };
	}, fixture.toString('base64'));
	expect(submission.status, submission.body).toBe(202);
	console.log('anti-spoof submission accepted');
	sessionId = JSON.parse(submission.body).session_id;
	await expect.poll(async () => (await pool.query(`SELECT status FROM attendance_sessions WHERE id = $1`, [sessionId])).rows[0]?.status, {
		timeout: 4 * 60 * 1000,
		intervals: [1000, 2000]
	}).toBe('review');
	await page.reload();
	await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 30_000 });
	sessionId = (await pool.query(
		`SELECT id FROM attendance_sessions WHERE pump_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
		[pump.id]
	)).rows[0].id;
	await expect(page.getByTestId('liveness-review-notice')).toContainText('need review');
	await expect(page.getByText('Live check passed').first()).toBeVisible();
	await expect(page.getByText('Could not verify').first()).toBeVisible();
	await expect(page.getByRole('button', { name: 'Retry with better photo' })).toBeVisible();
	await expect(page.getByRole('button', { name: /Done reviewing/ })).toBeVisible();

	const firstFace = page.getByTestId('worker-preview-trigger').first();
	await firstFace.click();
	await expect(page.getByTestId('worker-preview')).toBeVisible();
	await expect(page.getByTestId('worker-preview-image').locator('img')).toBeVisible();
	await page.getByRole('button', { name: 'Close worker preview' }).click();
	await page.screenshot({ path: path.join(output, `${testInfo.project.name}-mixed-review.png`), fullPage: true });

	const evidence = await pool.query(
		`SELECT liveness_status, liveness_model FROM attendance_face_evidence WHERE session_id = $1`,
		[sessionId]
	);
	expect(evidence.rows.length).toBeGreaterThan(0);
	expect(evidence.rows.some((row) => row.liveness_status === 'live')).toBeTruthy();
	expect(evidence.rows.every((row) => row.liveness_model === 'minifasnet-v2-1')).toBeTruthy();

	if (testInfo.project.name === 'desktop-chrome') {
		await page.getByRole('button', { name: /Done reviewing/ }).click();
		await expect(page.getByTestId('result-screen')).toBeHidden();
		const persisted = await pool.query(`SELECT status FROM attendance_sessions WHERE id = $1`, [sessionId]);
		expect(persisted.rows[0].status).toBe('completed');
	}
});
