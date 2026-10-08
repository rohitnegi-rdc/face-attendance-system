import { defineConfig } from '@playwright/test';
import path from 'node:path';

// API-level regression scenarios. Run through scripts/run-regression.mjs (npm run
// test:regression), which starts the database, stub AI, app and worker this config expects.
const outputDir =
	process.env.REGRESSION_OUTPUT_DIR || path.resolve('test-output', 'regression', 'adhoc');

export default defineConfig({
	testDir: 'tests/regression',
	testMatch: '**/*.spec.ts',
	// Settings are global, so scenarios run one at a time in a fixed order.
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 60_000,
	outputDir: path.join(outputDir, 'artifacts'),
	reporter: [
		['list'],
		['junit', { outputFile: path.join(outputDir, 'junit.xml') }],
		['html', { outputFolder: path.join(outputDir, 'report'), open: 'never' }]
	],
	use: {
		baseURL: process.env.REGRESSION_BASE_URL || 'http://127.0.0.1:53000'
	}
});
