// Plant manager accounts and plant assignments from 028_plant_managers.csv (a frozen copy of
// "Plant Managers.csv"), so location approval emails have someone to go to.
// Accounts sign in with Google (@rdc.in) only: no password is set, so the password login refuses
// them, and must_change_password is FALSE so Google sign-in goes straight to the dashboard.
// Plants are matched by normalized name, the same rule as the admin plant manager import. Rows for
// plants that are not in the database are skipped. Safe to rerun: an existing manager account is
// reused, and a plant that already has a manager keeps it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { pool } from '../../src/lib/server/db.ts';
import { normalizePlantName } from '../../src/lib/server/plantManagerImport.ts';

const csvFile = '028_plant_managers.csv';

export default async function up(): Promise<void> {
	const dir = path.dirname(fileURLToPath(import.meta.url));
	const rows: Record<string, string>[] = parse(await fs.readFile(path.join(dir, csvFile), 'utf-8'), {
		columns: true,
		skip_empty_lines: true,
		trim: true
	});

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const plants = (await client.query('SELECT id, name FROM plants')).rows as {
			id: string;
			name: string;
		}[];
		const byName = new Map<string, string[]>();
		for (const plant of plants) {
			const key = normalizePlantName(plant.name);
			byName.set(key, [...(byName.get(key) ?? []), plant.id]);
		}
		const admin = await client.query('SELECT id FROM admins ORDER BY created_at LIMIT 1');
		const adminId = admin.rows[0]?.id ?? null;

		let assigned = 0;
		let skipped = 0;
		const managers = new Set<string>();
		for (const row of rows) {
			const name = (row['Plant Manager Name'] || '').trim();
			const email = (row['Email ID'] || '').trim().toLowerCase();
			const candidates = byName.get(normalizePlantName(row['Plant Name'] || '')) ?? [];
			if (!name || !email || candidates.length !== 1) {
				skipped++;
				continue;
			}
			const plantId = candidates[0];
			await client.query(
				`INSERT INTO plant_managers (name, email, password_hash, must_change_password)
				 VALUES ($1, $2, NULL, FALSE) ON CONFLICT (lower(email)) DO NOTHING`,
				[name, email]
			);
			const manager = await client.query(
				'SELECT id, name FROM plant_managers WHERE lower(email) = $1',
				[email]
			);
			const managerId = manager.rows[0].id;
			managers.add(managerId);
			const inserted = await client.query(
				`INSERT INTO plant_manager_assignments (plant_id, manager_id, assigned_by)
				 VALUES ($1, $2, $3) ON CONFLICT (plant_id) DO NOTHING RETURNING plant_id`,
				[plantId, managerId, adminId]
			);
			if (!inserted.rowCount) {
				skipped++;
				continue;
			}
			await client.query(
				`INSERT INTO plant_manager_assignment_history (plant_id, old_manager_id, new_manager_id, changed_by)
				 VALUES ($1, NULL, $2, $3)`,
				[plantId, managerId, adminId]
			);
			await client.query(
				'UPDATE plants SET external_code = $1, manager_name = $2, manager_email = $3 WHERE id = $4',
				[(row['Plant Code'] || '').trim() || null, manager.rows[0].name, email, plantId]
			);
			assigned++;
		}
		await client.query('COMMIT');
		console.log(
			`  assigned ${assigned} plants to ${managers.size} plant managers, skipped ${skipped} rows`
		);
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}
