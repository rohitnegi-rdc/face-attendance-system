// ADM-15 guard: every SQL that counts fraud flags leaves out the ones an admin marked "not fraud"
// (src/lib/server/fraudCount.ts). A new count that forgets it would show cleared fraud again.
// Run: npm run test:unit, or alone: npx tsx --test tests/unit/fraudCount.test.ts (no database).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Counts that are not a "how much fraud" number: the admin delete check counts every flag of a
// session on purpose, cleared or not.
const ALLOWED = new Set(['src/lib/server/sessionCleanup.ts']);

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) return files(full);
		return /\.(ts|js|svelte)$/.test(name) ? [full] : [];
	});
}

test('every fraud flag count leaves out "not fraud" flags', () => {
	const misses: string[] = [];
	for (const file of [...files('src'), ...files('worker')]) {
		const rel = file.split(path.sep).join('/');
		if (ALLOWED.has(rel)) continue;
		const source = readFileSync(file, 'utf8');
		for (const sql of source.match(/`[^`]*`/g) ?? []) {
			if (!/fraud_flags/i.test(sql) || !/count\s*\(/i.test(sql)) continue;
			if (/countsAsFraud\(|NOT ff\.reviewed/.test(sql)) continue;
			misses.push(`${rel}: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
		}
	}
	assert.deepEqual(misses, []);
});
