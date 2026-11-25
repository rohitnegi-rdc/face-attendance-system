// Two Kerala pumps missing from the app (user's active Kerala list, 2026-11-25): KO1STM2 at
// KER-Kochi 1 Edyar and KKDSP1800 at KER-Kozikode, both STM CONCRETE-KL. Pump codes are the RDC
// Trak names, so the GPS feed reaches them with no provider id. Same importCsv() as the admin CSV
// upload: login <code>@pumps.rdc, password DEFAULT_PASSWORD. Safe to rerun (pumps upsert on code).
// A row whose Area, plant or vendor is not already there is skipped with a message, never creating
// a second plant or vendor under a slightly different name.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { query, queryOne } from '../../src/lib/server/db.ts';
import { importCsv } from '../../src/lib/server/csvImport.ts';

const csvFile = '058_kerala_pumps.csv';

export default async function up(): Promise<void> {
	if (!(await queryOne('SELECT 1 FROM pumps LIMIT 1'))) {
		console.log('  no pumps yet, skipping (an empty database is not the real one)');
		return;
	}
	const admin = await queryOne<{ id: string }>('SELECT id FROM admins ORDER BY created_at LIMIT 1');
	if (!admin) throw new Error('no admin to record the import against');

	const dir = path.dirname(fileURLToPath(import.meta.url));
	const text = await fs.readFile(path.join(dir, csvFile), 'utf-8');
	const rows: Record<string, string>[] = parse(text, {
		columns: true,
		skip_empty_lines: true,
		trim: true
	});
	const header = text.split(/\r?\n/)[0];
	const keep: string[] = [];
	for (const row of rows) {
		const found = await queryOne(
			`SELECT 1 FROM areas a JOIN plants pl ON pl.area_id = a.id
			 WHERE lower(a.name) = lower($1) AND lower(pl.name) = lower($2)
			   AND EXISTS (SELECT 1 FROM vendors v WHERE v.name = $3 AND v.area_id IS NULL)`,
			[row['Area Name'], row['Plant Name'], row['Vendor Name']]
		);
		if (!found) {
			console.log(
				`  SKIPPED ${row['PUMP Name']}: no plant "${row['Plant Name']}" in Area "${row['Area Name']}" ` +
					`or no vendor "${row['Vendor Name']}". Add it by the admin CSV upload.`
			);
			continue;
		}
		keep.push(Object.values(row).join(','));
	}
	if (!keep.length) return;

	const summary = await importCsv([header, ...keep].join('\n'));
	if (summary.errors.length) {
		throw new Error(`Kerala pump import had errors: ${JSON.stringify(summary.errors)}`);
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
		`  Kerala pumps: ${summary.pumps_created} added, ${summary.pumps_updated} already there`
	);
}
