import { defineConfig } from '@playwright/test';

// Visual walk-through against a running local stack with existing accounts (tests/live).
export default defineConfig({
	testDir: 'tests/live',
	testMatch: '**/*.e2e.ts',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	expect: { timeout: 30_000 },
	use: {
		// Must equal ORIGIN in .env. No faked x-forwarded-proto header: requests go out exactly as
		// a browser sends them, so a broken ORIGIN/CSRF setup fails here instead of being hidden.
		baseURL: process.env.LIVE_BASE_URL || 'http://localhost:6100',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	reporter: [['list'], ['html', { outputFolder: 'playwright-report/live', open: 'never' }]]
});
