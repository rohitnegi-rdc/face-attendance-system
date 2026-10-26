// Regression gate: npm run test:regression. Run it on your machine before pushing.
//
// Steps, stopping at the first failure:
//   1. At the same time:
//      - svelte-check
//      - production build (root base path)
//      - one throwaway Postgres per lane (tests/regression/docker-compose.yml, tmpfs) + init.sql,
//        then the migrations and a stand-in dump.pump_events table for the pump GPS feed.
//        The migrated database is saved once as a snapshot keyed by a hash of init.sql, the
//        migrations and this setup; later runs load the snapshot instead of migrating again.
//   2. Per lane: stub AI service + app + two workers (so jobs race across workers), wait for
//      /api/health.
//   3. Playwright scenarios in tests/regression (IDs from plans/RegressionTestPlan.md), the spec
//      files split across the lanes with --shard. Each lane has its own database, app, workers,
//      stub and logs, so lanes share nothing; inside a lane scenarios still run one at a time,
//      because settings are global.
//      Extra arguments go to Playwright, so `npm run test:regression -- pump-guide` runs one spec.
//
// REGRESSION_LANES sets the number of lanes (default 3; 1 runs everything in one lane).
// Everything is torn down at the end, pass or fail. Logs and the HTML reports go to
// test-output/regression/<timestamp>/ (one lane-N folder per lane).
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(root, 'test-output', 'regression', stamp);
const cacheDir = path.join(root, 'test-output', 'regression-cache');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });
const runLog = fs.createWriteStream(path.join(outDir, 'run.log'));

const playwrightArgs = process.argv.slice(2);
const LANES = Math.max(1, Number(process.env.REGRESSION_LANES ?? 3) || 1);
// Lane 1 keeps the ports the tests default to (6104 database, 6105 app, 6106 stub); each
// further lane moves up by 10.
const BASE_PORT = Number(process.env.REGRESSION_DB_PORT ?? 6104);
const COMPOSE_FILE = 'tests/regression/docker-compose.yml';
const isWindows = process.platform === 'win32';

// Same columns as the optimizer database's table that worker/gpsFeed.js reads.
const GPS_FEED_SQL = `CREATE SCHEMA IF NOT EXISTS dump;
	CREATE TABLE IF NOT EXISTS dump.pump_events (
		id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		pump_id VARCHAR(50) NOT NULL,
		event_timestamp TIMESTAMPTZ NOT NULL,
		latitude VARCHAR(30),
		longitude VARCHAR(30),
		raw_payload JSONB)`;

const lanes = Array.from({ length: LANES }, (_, i) => {
	const dbPort = String(BASE_PORT + i * 10);
	const appPort = String(BASE_PORT + i * 10 + 1);
	const stubPort = String(BASE_PORT + i * 10 + 2);
	const dir = LANES === 1 ? outDir : path.join(outDir, `lane-${i + 1}`);
	fs.mkdirSync(dir, { recursive: true });
	return {
		name: `lane ${i + 1}`,
		index: i,
		dir,
		dbPort,
		appPort,
		stubPort,
		project: `fa-regression-${i + 1}`,
		databaseUrl: `postgres://attendance:regression@127.0.0.1:${dbPort}/attendance`,
		baseUrl: `http://127.0.0.1:${appPort}`,
		stubUrl: `http://127.0.0.1:${stubPort}`
	};
});

const results = [];
const children = [];

function log(line) {
	const text = `[regression ${new Date().toLocaleTimeString('en-GB')}] ${line}`;
	console.log(text);
	runLog.write(`${text}\n`);
}

// Runs a command, streaming its output into a log file (run.log by default, and to the console
// with REGRESSION_VERBOSE=1). `input` is a file piped to its stdin; `stdoutFile` takes stdout.
function run(command, args, { env = {}, logFile, input, stdoutFile } = {}) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: root,
			env: { ...process.env, ...env },
			shell: isWindows
		});
		const sink = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : runLog;
		const stdoutSink = stdoutFile ? fs.createWriteStream(stdoutFile) : null;
		let tail = '';
		const capture = (chunk) => {
			sink.write(chunk);
			if (process.env.REGRESSION_VERBOSE) process.stdout.write(chunk);
			tail = (tail + chunk.toString()).slice(-6000);
		};
		if (stdoutSink) child.stdout.pipe(stdoutSink);
		else child.stdout.on('data', capture);
		child.stderr.on('data', capture);
		if (input) fs.createReadStream(input).pipe(child.stdin);
		child.on('error', (error) => resolve({ code: 1, tail: String(error) }));
		child.on('close', async (code) => {
			if (stdoutSink) await new Promise((r) => stdoutSink.end(r));
			if (logFile) sink.end();
			resolve({ code, tail });
		});
	});
}

function compose(lane, args, options = {}) {
	return run('docker', ['compose', '-p', lane.project, '-f', COMPOSE_FILE, ...args], {
		...options,
		env: { REGRESSION_DB_PORT: lane.dbPort, ...options.env }
	});
}

function startService(lane, name, args, env) {
	const file = path.join(lane.dir, `${name}.log`);
	const out = fs.openSync(file, 'a');
	const child = spawn(process.execPath, args, {
		cwd: root,
		env: { ...process.env, ...env },
		stdio: ['ignore', out, out]
	});
	children.push({ name: `${lane.name} ${name}`, child, file });
}

function tailFile(file, lines = 30) {
	try {
		return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
	} catch {
		return '(no log)';
	}
}

async function waitForHealth(lane, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let last = 'no response';
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${lane.baseUrl}/api/health`);
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
	return { code: 1, tail: `${lane.name}: health check timed out. Last response: ${last}` };
}

// One named step, timed and logged. Returns true when it passed.
async function step(name, action) {
	log(`START ${name}`);
	const started = Date.now();
	let outcome;
	try {
		outcome = await action();
	} catch (error) {
		outcome = { code: 1, tail: String(error?.stack || error) };
	}
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	results.push({ name, ok: outcome.code === 0, seconds });
	if (outcome.code === 0) {
		log(`PASS  ${name} (${seconds}s)`);
		return true;
	}
	log(`FAIL  ${name} (${seconds}s)`);
	console.error(`\n----- last output of "${name}" -----\n${outcome.tail.trimEnd()}\n-----`);
	return false;
}

// Steps that run at the same time; all of them must pass.
async function together(...steps) {
	const passed = await Promise.all(steps.map(([name, action]) => step(name, action)));
	return passed.every(Boolean);
}

function composeDown(lane) {
	spawnSync(
		'docker',
		['compose', '-p', lane.project, '-f', COMPOSE_FILE, 'down', '-v', '--remove-orphans'],
		{
			cwd: root,
			stdio: 'ignore',
			shell: isWindows,
			env: { ...process.env, REGRESSION_DB_PORT: lane.dbPort }
		}
	);
}

function teardown() {
	for (const { child } of children) {
		if (child.exitCode === null) child.kill();
	}
	for (const lane of lanes) composeDown(lane);
}

process.on('SIGINT', () => {
	teardown();
	process.exit(130);
});

// --- Database: migrate once, then reuse the snapshot ------------------------------------------

function schemaHash() {
	const hash = crypto.createHash('sha256');
	const migrations = path.join(root, 'db', 'migrations');
	for (const file of ['db/init.sql', 'scripts/migrate.ts']) {
		hash.update(file).update(fs.readFileSync(path.join(root, file)));
	}
	for (const file of fs.readdirSync(migrations).sort()) {
		hash.update(file).update(fs.readFileSync(path.join(migrations, file)));
	}
	hash.update(GPS_FEED_SQL);
	return hash.digest('hex').slice(0, 16);
}

const snapshot = path.join(cacheDir, `db-${schemaHash()}.sql`);

async function createGpsFeedTable(lane) {
	const client = new pg.Client({ connectionString: lane.databaseUrl });
	try {
		await client.connect();
		await client.query(GPS_FEED_SQL);
		return { code: 0, tail: '' };
	} catch (error) {
		return { code: 1, tail: String(error) };
	} finally {
		await client.end().catch(() => {});
	}
}

// Migrates lane 1 and saves the result as the snapshot (written to a temp file first, so a
// failed run never leaves half a snapshot behind).
async function buildSnapshot(lane) {
	const logFile = path.join(lane.dir, 'database.log');
	let result = await run('npx', ['tsx', 'scripts/migrate.ts'], {
		env: { DATABASE_URL: lane.databaseUrl },
		logFile
	});
	if (result.code !== 0) return result;
	result = await createGpsFeedTable(lane);
	if (result.code !== 0) return result;
	const temp = `${snapshot}.${process.pid}.tmp`;
	result = await compose(
		lane,
		[
			'exec',
			'-T',
			'postgres',
			'pg_dump',
			'-U',
			'attendance',
			'--clean',
			'--if-exists',
			'attendance'
		],
		{ logFile, stdoutFile: temp }
	);
	if (result.code !== 0) {
		fs.rmSync(temp, { force: true });
		return result;
	}
	fs.renameSync(temp, snapshot);
	// Older snapshots belong to schemas that no longer exist.
	for (const file of fs.readdirSync(cacheDir)) {
		if (/^db-[0-9a-f]+\.sql$/.test(file) && path.join(cacheDir, file) !== snapshot) {
			fs.rmSync(path.join(cacheDir, file), { force: true });
		}
	}
	return { code: 0, tail: '' };
}

function loadSnapshot(lane) {
	return compose(
		lane,
		[
			'exec',
			'-T',
			'postgres',
			'psql',
			'-q',
			'-v',
			'ON_ERROR_STOP=1',
			'-U',
			'attendance',
			'-d',
			'attendance'
		],
		{ logFile: path.join(lane.dir, 'database.log'), input: snapshot }
	);
}

async function prepareDatabases() {
	const up = await Promise.all(
		lanes.map((lane) => {
			composeDown(lane);
			return compose(lane, ['up', '-d', '--wait'], {
				logFile: path.join(lane.dir, 'database.log')
			});
		})
	);
	const failed = up.find((r) => r.code !== 0);
	if (failed) return failed;

	const cached = fs.existsSync(snapshot);
	log(cached ? 'Database snapshot found, loading it' : 'No database snapshot yet, migrating once');
	if (!cached) {
		const built = await buildSnapshot(lanes[0]);
		if (built.code !== 0) return built;
	}
	const loads = await Promise.all((cached ? lanes : lanes.slice(1)).map(loadSnapshot));
	return loads.find((r) => r.code !== 0) ?? { code: 0, tail: '' };
}

// --- Services and scenarios -------------------------------------------------------------------

function serviceEnv(lane) {
	return {
		DATABASE_URL: lane.databaseUrl,
		JWT_SECRET: 'regression-secret-at-least-32-characters-long',
		ORIGIN: lane.baseUrl,
		PORT: lane.appPort,
		HOST: '127.0.0.1',
		AI_SERVICE_URL: lane.stubUrl,
		UPLOAD_DIR: path.join(lane.dir, 'uploads'),
		FACE_MATCH_THRESHOLD: '', // empty on purpose: proves the 0.28 default (MATCH-06)
		EVENING_MIN_GAP_MINUTES: '',
		EVENING_PAIRING_WINDOW_HOURS: '',
		PHOTO_SPOOF_CHECK_ENABLED: 'false',
		GEMINI_API_KEY: '',
		SMTP_HOST: '',
		// Emails are logged, never sent; LOC-07 and PWD-01 read the log line (link and recipients).
		MAIL_ENABLED: 'false',
		// The pump GPS feed reads a stand-in dump.pump_events in the test database (LOC-08).
		PUMP_GPS_DB_HOST: '127.0.0.1',
		PUMP_GPS_DB_PORT: lane.dbPort,
		PUMP_GPS_DB_USER: 'attendance',
		PUMP_GPS_DB_PASSWORD: 'regression',
		PUMP_GPS_DB_NAME: 'attendance',
		PUMP_GPS_POLL_MINUTES: '0.05',
		WORKER_HEARTBEAT_INTERVAL_MS: '1000',
		// Short enough that the timeout and retry scenarios (WRK-10, WRK-11) finish in seconds.
		AI_REQUEST_TIMEOUT_MS: '3000',
		JOB_RETRY_BASE_SECONDS: '2',
		STUCK_JOB_SWEEP_SECONDS: '2',
		// Shift end reminders (REM-01): checked every second, sent to the stub's stand-in push
		// service over http (production takes https push services only).
		END_REMINDER_POLL_SECONDS: '1',
		PUSH_TEST_ENDPOINTS: 'true',
		TZ: 'UTC' // proves IST handling does not rely on the machine time zone
	};
}

async function startLane(lane) {
	const env = serviceEnv(lane);
	fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
	startService(lane, 'stub-ai', ['tests/regression/stub-ai.mjs'], { STUB_AI_PORT: lane.stubPort });
	startService(lane, 'app', ['build'], env);
	startService(lane, 'worker-1', ['worker/index.js'], {
		...env,
		HOSTNAME: `${lane.project}-worker-1`
	});
	startService(lane, 'worker-2', ['worker/index.js'], {
		...env,
		HOSTNAME: `${lane.project}-worker-2`
	});
	return waitForHealth(lane, 60_000);
}

function runScenarios(lane) {
	return run(
		'npx',
		[
			'playwright',
			'test',
			'--config=playwright.regression.config.ts',
			...(LANES > 1 ? [`--shard=${lane.index + 1}/${LANES}`, '--pass-with-no-tests'] : []),
			...playwrightArgs
		],
		{
			logFile: path.join(lane.dir, 'playwright.log'),
			env: {
				REGRESSION_BASE_URL: lane.baseUrl,
				REGRESSION_DATABASE_URL: lane.databaseUrl,
				REGRESSION_STUB_URL: lane.stubUrl,
				REGRESSION_UPLOAD_DIR: path.join(lane.dir, 'uploads'),
				REGRESSION_OUTPUT_DIR: lane.dir,
				// Plain text in playwright.log, so the summary below can read the counts.
				FORCE_COLOR: '0'
			}
		}
	);
}

function laneSummary(lane) {
	const text = tailFile(path.join(lane.dir, 'playwright.log'), 400);
	const counts = [...text.matchAll(/^\s*(\d+) (passed|failed|flaky|skipped|did not run)/gm)];
	return counts.map((m) => `${m[1]} ${m[2]}`).join(', ') || 'no tests';
}

let ok = true;
const started = Date.now();
try {
	log(`Output: ${path.relative(root, outDir)} (${LANES} lane${LANES === 1 ? '' : 's'})`);
	// Generated types once up front, so the type check and the build below do not both rewrite
	// .svelte-kit at the same moment.
	ok = await step('Sync SvelteKit types', () =>
		run('npx', ['svelte-kit', 'sync'], { logFile: path.join(outDir, 'check.log') })
	);
	ok &&= await together(
		[
			'Type check (svelte-check)',
			() =>
				run('npx', ['svelte-check', '--tsconfig', './tsconfig.json'], {
					logFile: path.join(outDir, 'check.log')
				})
		],
		[
			'Build app',
			() =>
				run('npm', ['run', 'build'], {
					env: { BASE_PATH: '' },
					logFile: path.join(outDir, 'build.log')
				})
		],
		['Prepare test databases', prepareDatabases]
	);
	if (ok) {
		ok = await together(
			...lanes.map((lane) => [
				`Start stub AI, app and workers (${lane.name})`,
				() => startLane(lane)
			])
		);
	}
	if (ok) {
		ok = await together(
			...lanes.map((lane) => [`Regression scenarios (${lane.name})`, () => runScenarios(lane)])
		);
		for (const lane of lanes) log(`${lane.name}: ${laneSummary(lane)}`);
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
console.log(`  Total: ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log(`  Full log: ${path.relative(root, path.join(outDir, 'run.log'))}`);
for (const lane of lanes) {
	const report = path.join(lane.dir, 'report', 'index.html');
	if (fs.existsSync(report)) console.log(`  Report (${lane.name}): ${path.relative(root, report)}`);
}
console.log(ok ? '\nREGRESSION PASSED' : '\nREGRESSION FAILED. Do not deploy.');
runLog.end();
process.exitCode = ok ? 0 : 1;
