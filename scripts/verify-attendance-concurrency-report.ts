import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(root, 'test-output', 'load-evaluations');
const runId = (await fs.readFile(path.join(outputRoot, 'latest-run.txt'), 'utf8')).trim();
const reportPath = path.join(outputRoot, runId, 'index.html');
const summary = JSON.parse(await fs.readFile(path.join(outputRoot, runId, 'summary.json'), 'utf8'));
const browser = await chromium.launch({ headless: true });

try {
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	const errors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	page.on('pageerror', (error) => errors.push(error.message));

	await page.goto(pathToFileURL(reportPath).href, { waitUntil: 'domcontentloaded' });
	if (
		(await page.locator('h1').textContent()) !==
		`${summary.virtual_agents}-Agent Attendance Concurrency Evaluation`
	)
		throw new Error('report title is missing');
	if ((await page.locator('#threshold option').count()) < 2)
		throw new Error('threshold selector is not populated');
	if ((await page.locator('#morningImage').getAttribute('src')) !== null)
		throw new Error('review image was loaded before user interaction');

	await page.locator('#requestDetails summary').click();
	await page.waitForFunction(
		(expected) => document.querySelectorAll('#requestTable tbody tr').length === expected,
		summary.total_requests,
		{ timeout: 5_000 }
	);
	const reportText = await page.locator('body').innerText();
	if (!reportText.includes('Speed percentiles (minutes)') || !reportText.includes('API min'))
		throw new Error('minute-based duration labels are missing');
	if (/\d(?:\.\d+)? ms\b/.test(reportText))
		throw new Error('a visible duration is still rendered in milliseconds');

	await page.locator('.case').first().click();
	await page.locator('#morningImage').waitFor({ state: 'visible' });
	await page.waitForFunction(() => {
		const morning = document.querySelector<HTMLImageElement>('#morningImage');
		const evening = document.querySelector<HTMLImageElement>('#eveningImage');
		return Boolean(
			morning?.complete && morning.naturalWidth && evening?.complete && evening.naturalWidth
		);
	});
	if (errors.length) throw new Error(`browser errors: ${errors.join(' | ')}`);

	await page.screenshot({
		path: path.join(outputRoot, runId, 'report-verification.png'),
		fullPage: false
	});
	console.log(`Verified ${reportPath}`);
} finally {
	await browser.close();
}
