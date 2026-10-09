import { defineConfig } from '@playwright/test';

export default defineConfig({
	testMatch: '**/attendance-loadtest.e2e.ts',
	fullyParallel: false,
	workers: 1,
	timeout: 5 * 60 * 1000,
	// 200+ roster columns render slower than typical pages — generous but not unbounded.
	expect: { timeout: 30_000 },
	retries: 0,
	use: {
		baseURL: process.env.ATTENDANCE_E2E_BASE_URL || 'http://localhost:6100',
		actionTimeout: 15_000,
		navigationTimeout: 60_000,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	reporter: [
		['list'],
		['html', { outputFolder: 'test-output/pump-page-loadtest/report', open: 'never' }]
	]
});
