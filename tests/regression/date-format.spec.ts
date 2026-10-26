// UI-14: every date is DD-MM-YYYY. A source scan keeps any other date format from coming back,
// and the pump screen shows today's date bold at the top right with what it is.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { BASE_URL, PASSWORD, createArea, createPump } from './helpers';

const ROOTS = ['src', 'worker'];
const FORBIDDEN: [RegExp, string][] = [
	[/'(Dy, )?DD Mon\b/, 'SQL to_char with a month name'],
	[/MMM/, 'dayjs month name'],
	[/toLocale(Date|Time)?String\(/, 'browser locale date'],
	[/Intl\.DateTimeFormat/, 'Intl date format'],
	[/'ddd dd mmm yyyy'/, 'Excel month name format']
];

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.(ts|js|svelte)$/.test(name) ? [path] : [];
	});
}

test('UI-14 no source file formats a date other than DD-MM-YYYY', () => {
	const hits: string[] = [];
	for (const file of ROOTS.flatMap(sourceFiles)) {
		readFileSync(file, 'utf8')
			.split('\n')
			.forEach((line, i) => {
				for (const [pattern, why] of FORBIDDEN) {
					if (pattern.test(line)) hits.push(`${file}:${i + 1} ${why}: ${line.trim()}`);
				}
			});
	}
	expect(hits).toEqual([]);
});

test('UI-14 the pump screen shows the date bold at the top right, labelled', async ({ page }) => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const response = await page.request.post('/api/auth/login', {
		data: { email: pump.email, password: PASSWORD },
		headers: { origin: BASE_URL }
	});
	expect(response.status()).toBe(200);

	const ist = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Asia/Kolkata',
		day: '2-digit',
		month: '2-digit',
		year: 'numeric'
	})
		.format(new Date())
		.replaceAll('/', '-');

	await page.goto('/pump');
	const date = page.getByTestId('heading-date');
	await expect(date.locator('strong')).toHaveText(ist);
	await expect(date.locator('span')).toContainText('आज ·');
	expect(await date.locator('strong').evaluate((el) => getComputedStyle(el).fontWeight)).toBe(
		'800'
	);
});
