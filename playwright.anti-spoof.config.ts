import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testMatch: '**/attendance-anti-spoof.e2e.ts',
	fullyParallel: false,
	workers: 1,
	timeout: 5 * 60 * 1000,
	expect: { timeout: 30_000 },
	retries: 0,
	use: {
		baseURL: process.env.ANTI_SPOOF_E2E_BASE_URL || 'https://127.0.0.1:3443',
		ignoreHTTPSErrors: true,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure'
	},
	projects: [
		{ name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
		{ name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } }
	],
	reporter: [
		['list'],
		['html', { outputFolder: 'test-output/anti-spoofing/playwright-report', open: 'never' }]
	]
});
