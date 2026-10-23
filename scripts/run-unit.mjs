// Unit tests: npm run test:unit. Separate from the regression gate and much faster: no build, no
// app, no worker, no stub AI. The face queries are SQL, so they run against a real throwaway
// pgvector Postgres (the regression compose file under its own project name and port, tmpfs).
//
// Steps: start the database, apply init.sql + migrations, run tests/unit/*.test.ts with Node's
// test runner (through tsx), tear the database down, pass or fail.
// UNIT_DATABASE_URL set: use that database instead (it must already be migrated and throwaway).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const DB_PORT = process.env.UNIT_DB_PORT ?? '6114';
const COMPOSE = ['compose', '-p', 'fa-unit', '-f', 'tests/regression/docker-compose.yml'];
const isWindows = process.platform === 'win32';
const external = process.env.UNIT_DATABASE_URL;
const DATABASE_URL = external ?? `postgres://attendance:regression@127.0.0.1:${DB_PORT}/attendance`;

function run(command, args, env = {}) {
	const result = spawnSync(command, args, {
		cwd: root,
		env: { ...process.env, ...env },
		stdio: 'inherit',
		shell: isWindows
	});
	return result.status ?? 1;
}

function down() {
	spawnSync('docker', [...COMPOSE, 'down', '-v', '--remove-orphans'], {
		cwd: root,
		stdio: 'ignore',
		shell: isWindows
	});
}

let code = 0;
try {
	if (!external) {
		down();
		code = run('docker', [...COMPOSE, 'up', '-d', '--wait'], { REGRESSION_DB_PORT: DB_PORT });
		if (code === 0) code = run('npx', ['tsx', 'scripts/migrate.ts'], { DATABASE_URL });
	}
	if (code === 0) {
		code = run('npx', ['tsx', '--test', 'tests/unit/*.test.ts'], {
			UNIT_DATABASE_URL: DATABASE_URL,
			FACE_MATCH_THRESHOLD: ''
		});
	}
} finally {
	if (!external) down();
}
process.exit(code);
