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
		baseURL: process.env.LIVE_BASE_URL || 'http://127.0.0.1:3001',
		// The app trusts x-forwarded-proto (set by the HTTPS proxy in production) and assumes
		// https without it, which makes plain-http uploads fail the CSRF origin check.
		extraHTTPHeaders: { 'x-forwarded-proto': 'http' },
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	reporter: [['list'], ['html', { outputFolder: 'playwright-report/live', open: 'never' }]]
});
