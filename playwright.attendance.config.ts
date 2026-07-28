import { defineConfig } from '@playwright/test';

export default defineConfig({
	testMatch: '**/attendance-pipeline-ui.e2e.ts',
	fullyParallel: false,
	workers: 1,
	timeout: 6 * 60 * 1000,
	expect: { timeout: 30_000 },
	retries: 0,
	use: {
		baseURL: process.env.ATTENDANCE_E2E_BASE_URL || 'http://localhost:3000',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	reporter: [['list'], ['html', { outputFolder: 'playwright-report/attendance', open: 'never' }]]
});
