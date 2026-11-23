import { defineConfig } from '@playwright/test';
import base from './playwright.regression.config';

// The regression scenarios named by their path from the repo root (the deep-build gate matches
// specs that way): node scripts/run-regression.mjs playwright test --config=playwright.paths.config.ts <specs>
export default defineConfig({
	...base,
	testDir: '.',
	testMatch: ['tests/regression/**/*.spec.ts'],
	// Agent worktrees under .claude hold stale copies of the specs; never run those.
	testIgnore: ['**/.claude/**', '**/node_modules/**']
});
