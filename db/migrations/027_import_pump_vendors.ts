// Real pumps, plants, areas and vendors for a fresh database, from 027_pump_vendors.csv (a frozen
// copy of "Pump Vendor.csv"). Uses the same importCsv() as the admin CSV upload, so logins match:
// <pump code>@pumps.rdc and <vendor>@vendors.rdc, password Test1234!, forced change at first
// sign-in (must_change_password defaults TRUE).
// Runs only when there are no pumps yet: a database that already has pumps keeps them untouched.
// Logged in csv_imports against the first admin (created by 026_bootstrap_admin.sql).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, queryOne } from '../../src/lib/server/db.ts';
import { importCsv } from '../../src/lib/server/csvImport.ts';

const csvFile = '027_pump_vendors.csv';

export default async function up(): Promise<void> {
	if (await queryOne('SELECT 1 FROM pumps LIMIT 1')) {
		console.log('  pumps already exist, skipping CSV import');
		return;
	}
	const admin = await queryOne<{ id: string }>('SELECT id FROM admins ORDER BY created_at LIMIT 1');
	if (!admin) throw new Error('no admin to record the import against');

	const dir = path.dirname(fileURLToPath(import.meta.url));
	const summary = await importCsv(await fs.readFile(path.join(dir, csvFile), 'utf-8'));
	if (summary.errors.length) {
		throw new Error(`pump CSV import had errors: ${JSON.stringify(summary.errors)}`);
	}
	await query(
		`INSERT INTO csv_imports (admin_id, filename, rows_total, rows_created, rows_skipped, errors_json)
		 VALUES ($1, $2, $3, $4, $5, '[]')`,
		[
			admin.id,
			`${csvFile} (migration)`,
			summary.rows_total,
			summary.rows_created,
			summary.rows_skipped
		]
	);
	console.log(
		`  imported ${summary.pumps_created} pumps, ${summary.plants_created} plants, ` +
			`${summary.areas_created} areas, ${summary.vendors_created} vendors`
	);
}
