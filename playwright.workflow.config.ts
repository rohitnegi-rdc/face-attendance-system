import { defineConfig } from '@playwright/test';

export default defineConfig({
	testMatch: '**/attendance-workflow-deep.e2e.ts',
	fullyParallel: false,
	workers: 1,
	timeout: 10 * 60 * 1000,
	expect: { timeout: 45_000 },
	retries: 0,
	use: {
		baseURL: process.env.ATTENDANCE_E2E_BASE_URL || 'http://localhost:6100',
		actionTimeout: 15_000,
		navigationTimeout: 45_000,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
		launchOptions: {
			args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
		}
	},
	reporter: [['list'], ['html', { outputFolder: 'test-output/attendance-workflow/report', open: 'never' }]]
});
