import { defineConfig } from '@playwright/test';
import path from 'node:path';

// The regularisation scenarios and the calendar's screenshot tests, run on the throwaway stack:
// node scripts/run-regression.mjs playwright test --config=playwright.regularisation.config.ts
// (npm run test:visual, npm run test:visual:update). testDir is the repo root so reporters name
// each spec by its path from there.
const outputDir =
	process.env.REGRESSION_OUTPUT_DIR || path.resolve('test-output', 'regression', 'adhoc');

export default defineConfig({
	testDir: '.',
	testMatch: ['tests/regression/regularisation*.spec.ts', 'tests/visual/**/*.spec.ts'],
	// Baselines belong to one system: Hindi text is drawn differently elsewhere.
	snapshotPathTemplate: 'tests/visual/__screenshots__/{platform}/{arg}{ext}',
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 90_000,
	expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.005, animations: 'disabled' } },
	outputDir: path.join(outputDir, 'artifacts'),
	reporter: [['list']],
	use: {
		baseURL: process.env.REGRESSION_BASE_URL || 'http://127.0.0.1:6105',
		trace: 'retain-on-failure'
	}
});
