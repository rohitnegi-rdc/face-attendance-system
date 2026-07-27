// Seed script — creates 1 admin, then imports the sample CSV via the SAME
// import code path the admin UI uses (plans/MasterPlan.md §8/Prompt A AUTH).
// Does NOT pre-seed persons — those are only ever created by the real
// face-detection pipeline (run scripts/submit-test-photos.ts afterward).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, queryOne, pool } from '../src/lib/server/db.ts';
import { hashPassword } from '../src/lib/server/auth.ts';
import { importCsv } from '../src/lib/server/csvImport.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
	const adminEmail = 'admin@attendance.local';
	const existingAdmin = await queryOne('SELECT id FROM admins WHERE email = $1', [adminEmail]);
	let adminId: string;
	if (!existingAdmin) {
		const passwordHash = await hashPassword('Admin1234!');
		const created = await queryOne<any>(
			'INSERT INTO admins (email, password_hash) VALUES ($1, $2) RETURNING id',
			[adminEmail, passwordHash]
		);
		adminId = created.id;
		console.log(`created admin: ${adminEmail} / Admin1234!`);
	} else {
		adminId = (existingAdmin as any).id;
		console.log('admin already exists, skipping');
	}

	const csvPath = path.join(__dirname, '..', 'tests', 'fixtures', 'sample-vendor-pump-data.csv');
	const csvText = fs.readFileSync(csvPath, 'utf-8');
	const summary = await importCsv(csvText);

	await query(
		`INSERT INTO csv_imports (admin_id, filename, rows_total, rows_created, rows_skipped, errors_json)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		[
			adminId,
			'sample-vendor-pump-data.csv (seed)',
			summary.rows_total,
			summary.rows_created,
			summary.rows_skipped,
			JSON.stringify(summary.errors)
		]
	);

	console.log('seed import summary:', summary);
	console.log('\nSample pump logins (password Test1234!): aslpwwi2@pumps.local, bglprvn1@pumps.local, ...');
	console.log('Sample vendor logins (password Test1234!): rvnenterprises@vendors.local, ...');

	await pool.end();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
