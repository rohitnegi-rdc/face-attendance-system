import { defineConfig } from '@playwright/test';

export default defineConfig({
	webServer: {
		command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4177 --strictPort',
		port: 4177,
		reuseExistingServer: true,
		env: {
			DATABASE_URL:
				process.env.DATABASE_URL || 'postgres://attendance:attendance@localhost:5433/attendance',
			JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-me'
		}
	},
	testMatch: '**/*.e2e.{ts,js}',
	testIgnore: '**/attendance-pipeline-ui.e2e.ts',
	use: {
		baseURL: 'http://127.0.0.1:4177',
		trace: 'retain-on-failure'
	}
});
