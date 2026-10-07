import { defineConfig } from '@playwright/test';

const externalBaseUrl = process.env.AUDIT_BASE_URL;

export default defineConfig({
	webServer: externalBaseUrl
		? undefined
		: {
				command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4179 --strictPort',
				port: 4179,
				reuseExistingServer: false,
				timeout: 180_000,
				env: {
					DATABASE_URL:
						process.env.DATABASE_URL ||
						'postgres://attendance:attendance@localhost:5433/attendance',
					JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-me'
				}
			},
	testMatch: '**/interactive-ui-audit.e2e.ts',
	workers: 1,
	fullyParallel: false,
	timeout: 240_000,
	reporter: [['list'], ['html', { outputFolder: 'test-output/ui-audit/report', open: 'never' }]],
	use: {
		baseURL: externalBaseUrl || 'http://127.0.0.1:4179',
		timezoneId: 'America/Los_Angeles',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure'
	}
});
