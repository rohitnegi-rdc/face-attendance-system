// Plant manager logins start on the default password (user decision 2026-11-25). Until now the
// plant managers imported by migration 028 (and business managers and heads, 049/052) had no
// password and could only sign in with Google. Each gets DEFAULT_PASSWORD; signing in with it
// makes them choose their own at once (api/auth/login), and Google sign-in keeps working as before.
// A login that already has a password keeps it. Safe to rerun.
import { query } from '../../src/lib/server/db.ts';
import { DEFAULT_PASSWORD, hashPassword } from '../../src/lib/server/auth.ts';

export default async function up(): Promise<void> {
	const rows = await query<{ id: string }>(
		`UPDATE plant_managers SET password_hash = $1 WHERE password_hash IS NULL RETURNING id`,
		[await hashPassword(DEFAULT_PASSWORD)]
	);
	console.log(`  plant manager logins given the starting password: ${rows.length}`);
}
