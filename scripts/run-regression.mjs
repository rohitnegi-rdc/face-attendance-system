// Regression gate: npm run test:regression (also run by scripts/deploy.sh before anything ships).
//
// Steps, stopping at the first failure:
//   1. svelte-check
//   2. throwaway Postgres (tests/regression/docker-compose.yml, tmpfs) + init.sql
//   3. migrations
//   4. production build (root base path)
//   5. stub AI service + app + worker, wait for /api/health
//   6. Playwright API scenarios in tests/regression (IDs from plans/RegressionTestPlan.md)
// Everything is torn down at the end, pass or fail. Logs and the HTML report go to
// test-output/regression/<timestamp>/.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(root, 'test-output', 'regression', stamp);
fs.mkdirSync(outDir, { recursive: true });
const runLog = fs.createWriteStream(path.join(outDir, 'run.log'));

const DB_PORT = process.env.REGRESSION_DB_PORT ?? '55432';
const APP_PORT = process.env.REGRESSION_APP_PORT ?? '53000';
const STUB_PORT = process.env.REGRESSION_STUB_PORT ?? '58000';
const DATABASE_URL = `postgres://attendance:regression@127.0.0.1:${DB_PORT}/attendance`;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;
const COMPOSE = ['compose', '-f', 'tests/regression/docker-compose.yml'];
const isWindows = process.platform === 'win32';

const results = [];
const children = [];

function log(line) {
	const text = `[regression ${new Date().toLocaleTimeString('en-GB')}] ${line}`;
	console.log(text);
	runLog.write(`${text}\n`);
}

// Runs a command, streaming its output into run.log (and to the console with REGRESSION_VERBOSE=1).
function run(command, args, env = {}) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: root,
			env: { ...process.env, ...env },
			shell: isWindows
		});
		let tail = '';
		const capture = (chunk) => {
			runLog.write(chunk);
			if (process.env.REGRESSION_VERBOSE) process.stdout.write(chunk);
			tail = (tail + chunk.toString()).slice(-6000);
		};
		child.stdout.on('data', capture);
		child.stderr.on('data', capture);
		child.on('error', (error) => resolve({ code: 1, tail: String(error) }));
		child.on('close', (code) => resolve({ code, tail }));
	});
}

function startService(name, args, env) {
	const file = path.join(outDir, `${name}.log`);
	const out = fs.openSync(file, 'a');
	const child = spawn(process.execPath, args, {
		cwd: root,
		env: { ...process.env, ...env },
		stdio: ['ignore', out, out]
	});
	children.push({ name, child, file });
}

function tailFile(file, lines = 30) {
	try {
		return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
	} catch {
		return '(no log)';
	}
}

async function waitForHealth(timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let last = 'no response';
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${BASE_URL}/api/health`);
			last = `${response.status} ${await response.text()}`;
			if (response.ok) return { code: 0, tail: last };
		} catch (error) {
			last = String(error);
		}
		for (const { name, child } of children) {
			if (child.exitCode !== null) {
				return { code: 1, tail: `${name} exited early (code ${child.exitCode})` };
			}
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	return { code: 1, tail: `health check timed out. Last response: ${last}` };
}

async function step(name, action) {
	log(`START ${name}`);
	const started = Date.now();
	const { code, tail } = await action();
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	results.push({ name, ok: code === 0, seconds });
	if (code === 0) {
		log(`PASS  ${name} (${seconds}s)`);
		return true;
	}
	log(`FAIL  ${name} (${seconds}s)`);
	console.error(`\n----- last output of "${name}" -----\n${tail.trimEnd()}\n-----`);
	return false;
}

function composeDown() {
	spawnSync('docker', [...COMPOSE, 'down', '-v', '--remove-orphans'], {
		cwd: root,
		stdio: 'ignore',
		shell: isWindows
	});
}

function teardown() {
	for (const { child } of children) {
		if (child.exitCode === null) child.kill();
	}
	composeDown();
}

process.on('SIGINT', () => {
	teardown();
	process.exit(130);
});

const serviceEnv = {
	DATABASE_URL,
	JWT_SECRET: 'regression-secret-at-least-32-characters-long',
	ORIGIN: BASE_URL,
	PORT: APP_PORT,
	HOST: '127.0.0.1',
	AI_SERVICE_URL: STUB_URL,
	UPLOAD_DIR: path.join(outDir, 'uploads'),
	FACE_MATCH_THRESHOLD: '', // empty on purpose: proves the 0.28 default (MATCH-06)
	EVENING_MIN_GAP_MINUTES: '',
	EVENING_PAIRING_WINDOW_HOURS: '',
	PHOTO_SPOOF_CHECK_ENABLED: 'false',
	GEMINI_API_KEY: '',
	SMTP_HOST: '',
	WORKER_HEARTBEAT_INTERVAL_MS: '1000',
	TZ: 'UTC' // proves IST handling does not rely on the machine time zone
};

const steps = [
	['Type check (svelte-check)', () => run('npm', ['run', 'check'])],
	[
		'Start test database',
		() => {
			composeDown();
			return run('docker', [...COMPOSE, 'up', '-d', '--wait'], { REGRESSION_DB_PORT: DB_PORT });
		}
	],
	['Apply migrations', () => run('npx', ['tsx', 'scripts/migrate.ts'], { DATABASE_URL })],
	['Build app', () => run('npm', ['run', 'build'], { BASE_PATH: '' })],
	[
		'Start stub AI, app and worker',
		() => {
			fs.mkdirSync(serviceEnv.UPLOAD_DIR, { recursive: true });
			startService('stub-ai', ['tests/regression/stub-ai.mjs'], { STUB_AI_PORT: STUB_PORT });
			startService('app', ['build'], serviceEnv);
			startService('worker', ['worker/index.js'], serviceEnv);
			return waitForHealth(60_000);
		}
	],
	[
		'Regression scenarios (Playwright)',
		() =>
			run('npx', ['playwright', 'test', '--config=playwright.regression.config.ts'], {
				REGRESSION_BASE_URL: BASE_URL,
				REGRESSION_DATABASE_URL: DATABASE_URL,
				REGRESSION_STUB_URL: STUB_URL,
				REGRESSION_OUTPUT_DIR: outDir
			})
	]
];

let ok = true;
try {
	log(`Output: ${path.relative(root, outDir)}`);
	for (const [name, action] of steps) {
		if (!(await step(name, action))) {
			ok = false;
			break;
		}
	}
} catch (error) {
	ok = false;
	log(`Runner error: ${error?.stack || error}`);
} finally {
	if (!ok) {
		for (const { name, file } of children) {
			console.error(`\n----- last lines of ${name}.log -----\n${tailFile(file)}`);
		}
	}
	teardown();
}

console.log('\nRegression summary');
for (const result of results) {
	console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name} (${result.seconds}s)`);
}
console.log(`  Full log: ${path.relative(root, path.join(outDir, 'run.log'))}`);
if (results.some((result) => result.name.startsWith('Regression scenarios'))) {
	console.log(`  Report:   ${path.relative(root, path.join(outDir, 'report', 'index.html'))}`);
}
console.log(ok ? '\nREGRESSION PASSED' : '\nREGRESSION FAILED. Do not deploy.');
runLog.end();
process.exitCode = ok ? 0 : 1;
