// Business heads and their plants from 052_business_heads.csv (taken from the mapping the user
// gave on 2026-11-17, BHBMPLANTSMAPPING.MD, plant names as in 049_business_managers.csv). Logins
// sign in with Google like plant managers and see their plants read only. Rows for plants not in
// the system yet wait in business_head_waiting and join their plant once it is added
// (src/lib/server/businessManagers.ts, role 'head'). Safe to rerun.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../../src/lib/server/db.ts';
import {
	importBusinessManagers,
	parseBusinessManagerCsv
} from '../../src/lib/server/businessManagers.ts';

export default async function up(): Promise<void> {
	const dir = path.dirname(fileURLToPath(import.meta.url));
	const rows = parseBusinessManagerCsv(
		await fs.readFile(path.join(dir, '052_business_heads.csv'), 'utf-8'),
		'head'
	);
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const admin = await client.query('SELECT id FROM admins ORDER BY created_at LIMIT 1');
		const summary = await importBusinessManagers(client, rows, admin.rows[0]?.id ?? null, 'head');
		await client.query('COMMIT');
		console.log(
			`  ${summary.managers} business heads: ${summary.assigned} plants assigned, ${summary.waiting} waiting for their plant${summary.errors.length ? `, ${summary.errors.length} rows refused` : ''}`
		);
		for (const error of summary.errors) console.log(`    ${error}`);
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}
