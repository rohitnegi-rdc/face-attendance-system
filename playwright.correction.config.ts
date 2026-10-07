import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testMatch: '**/admin-attendance-correction.e2e.ts',
	fullyParallel: false,
	workers: 1,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	use: {
		baseURL: process.env.CORRECTION_BASE_URL || 'https://127.0.0.1:3443',
		ignoreHTTPSErrors: true,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure'
	},
	projects: [
		{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
		{ name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } }
	],
	reporter: [
		['list'],
		['html', { outputFolder: 'test-output/attendance-correction/report', open: 'never' }]
	]
});
