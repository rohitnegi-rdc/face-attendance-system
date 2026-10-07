import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(root, 'test-output', 'load-evaluations');
const matrixId = (await fs.readFile(path.join(outputRoot, 'latest-matrix.txt'), 'utf8')).trim();
const reportPath = path.join(outputRoot, matrixId, 'index.html');
const browser = await chromium.launch({ headless: true });

try {
	const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
	const errors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(pathToFileURL(reportPath).href, { waitUntil: 'domcontentloaded' });
	if ((await page.locator('h1').textContent()) !== 'Attendance concurrency comparison')
		throw new Error('comparison report title is missing');
	if ((await page.locator('table').first().locator('tbody tr').count()) !== 5)
		throw new Error('comparison report does not contain five concurrency levels');
	if (!(await page.locator('body').innerText()).includes('Queue p95 min'))
		throw new Error('minute-based queue metrics are missing');
	if ((await page.locator('a[href*="attendance-50-agents"]').count()) !== 1)
		throw new Error('50-agent report link is missing');
	if (errors.length) throw new Error(`browser errors: ${errors.join(' | ')}`);
	await page.screenshot({
		path: path.join(outputRoot, matrixId, 'matrix-report-verification.png'),
		fullPage: false
	});
	console.log(`Verified ${reportPath}`);
} finally {
	await browser.close();
}
