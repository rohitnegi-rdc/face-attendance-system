// Local secrets live in one env file OUTSIDE the repo, so they are never committed, copied into an
// image or shown in a diff. Values are never printed: only the file path and variable names are.
//
// Where it looks, first match wins:
//   1. FACE_ATTENDANCE_ENV=<path>
//   2. ../face-attendance.env (next to the repo folder)
//   3. ./.env (the old place, until it is moved)
// No file found: nothing is loaded (inside Docker, Compose already passed the environment).
//
// Values already in the environment win over the file. MAIL_ENABLED is always forced to false:
// nothing started from this machine may send real email (src/lib/server/mail.ts).
//
// Use: node --import ./scripts/lib/load-env.mjs <script>, or import { loadEnv } from here.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function envFile() {
	const candidates = [
		process.env.FACE_ATTENDANCE_ENV,
		path.resolve(repo, '..', 'face-attendance.env'),
		path.join(repo, '.env')
	].filter(Boolean);
	return candidates.find((file) => existsSync(file)) ?? null;
}

// Returns the file used and the names it set (never the values). Loads once per process.
let loaded;
export function loadEnv() {
	if (loaded) return loaded;
	const file = envFile();
	const names = [];
	if (file) {
		for (const [name, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
			if (process.env[name] === undefined) {
				process.env[name] = value;
				names.push(name);
			}
		}
	}
	process.env.MAIL_ENABLED = 'false';
	loaded = { file, names };
	return loaded;
}

loadEnv();
