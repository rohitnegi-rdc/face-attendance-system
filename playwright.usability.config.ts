import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testMatch: '**/attendance-usability.e2e.ts',
	fullyParallel: false,
	workers: 1,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	retries: 0,
	use: {
		baseURL: process.env.USABILITY_BASE_URL || 'http://127.0.0.1:3001',
		actionTimeout: 15_000,
		navigationTimeout: 45_000,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure'
	},
	projects: [
		{
			name: 'desktop',
			use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
		},
		{
			name: 'mobile',
			use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }
		}
	],
	reporter: [
		['list'],
		['html', { outputFolder: 'test-output/attendance-usability/report', open: 'never' }]
	]
});
