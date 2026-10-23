// The local Docker stack with the env file from outside the repo (scripts/lib/load-env.mjs) and
// the LAN override, which also forces MAIL_ENABLED=false so local runs never send email.
//   npm run stack -- up -d --build
//   npm run stack -- ps
//   npm run stack -- logs -f app
// Prints the env file path and how many variables it holds, never their values.
import { spawn } from 'node:child_process';
import { loadEnv } from './lib/load-env.mjs';

const { file, names } = loadEnv();
if (!file) {
	console.error('No env file found. Put it at ../face-attendance.env or set FACE_ATTENDANCE_ENV.');
	process.exit(1);
}
console.log(`[stack] env file ${file} (${names.length} variables), mail off`);

const args = [
	'compose',
	'--env-file',
	file,
	'-f',
	'docker-compose.yml',
	'-f',
	'docker-compose.lan.override.yml',
	...process.argv.slice(2)
];
spawn('docker', args, { stdio: 'inherit', env: process.env }).on('exit', (code) =>
	process.exit(code ?? 1)
);
