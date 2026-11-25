// Kerala plant managers from the user's updated list (Plant Managers Kerala.xlsx, 2026-11-25):
// KER-Kottayam moves from Jithin P K to Abhilash M Nair; every other plant already matches.
// Does what the admin Plant managers page's Assign does, plant by plant, in one transaction each:
// creates the login if new (password DEFAULT_PASSWORD, asked to change at the first sign-in),
// points the plant at it, writes plant_manager_assignment_history. A plant already on its manager
// is left alone, so it is safe to rerun. The old manager keeps the login, with no plant (as Assign
// leaves it). KER-Thrissur 2 is not on the list and stays without a plant manager.
import { pool, queryOne } from '../../src/lib/server/db.ts';
import { DEFAULT_PASSWORD, hashPassword } from '../../src/lib/server/auth.ts';

const MANAGERS: { plant: string; name: string; email: string }[] = [
	{ plant: 'KER-Kochi 1 Edyar', name: 'Sebastian Shine', email: 'sebastian.shine@rdc.in' },
	{ plant: 'KER-Kochi 2 Amb', name: 'Mohammed Asif T A', email: 'asif.ta@rdc.in' },
	{ plant: 'KER-Kottayam', name: 'Abhilash M Nair', email: 'abhilash.nair@rdc.in' },
	{ plant: 'KER-Kozikode', name: 'Abhinand Sarathkumar', email: 'abhinand.kumar@rdc.in' },
	{ plant: 'KER-Thrissur 1', name: 'Scion C S', email: 'scion.cs@rdc.in' },
	{ plant: 'KER-Trivandrum 1', name: 'UNNIKRISHNAN NAIR', email: 'unnikrishnan.nair@rdc.in' },
	{ plant: 'KER-Trivandrum 2', name: 'UNNIKRISHNAN NAIR', email: 'unnikrishnan.nair@rdc.in' },
	{ plant: 'KER-Wayanad', name: 'Emil Reemon', email: 'emil.reemon@rdc.in' }
];

export default async function up(): Promise<void> {
	if (!(await queryOne(`SELECT 1 FROM plants WHERE name LIKE 'KER-%' LIMIT 1`))) {
		console.log('  no Kerala plants, skipping');
		return;
	}
	const admin = await queryOne<{ id: string }>('SELECT id FROM admins ORDER BY created_at LIMIT 1');
	let startHash: string | undefined;
	for (const row of MANAGERS) {
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const plant = (
				await client.query<{ id: string }>(
					'SELECT id FROM plants WHERE lower(name) = lower($1) FOR UPDATE',
					[row.plant]
				)
			).rows[0];
			if (!plant) {
				console.log(`  ${row.plant}: no such plant, skipped`);
				await client.query('ROLLBACK');
				continue;
			}
			let manager = (
				await client.query<{ id: string; password_hash: string | null }>(
					'SELECT id, password_hash FROM plant_managers WHERE lower(email) = $1 FOR UPDATE',
					[row.email]
				)
			).rows[0];
			if (!manager) {
				manager = (
					await client.query<{ id: string; password_hash: string | null }>(
						`INSERT INTO plant_managers (name, email, password_hash) VALUES ($1, $2, $3)
						 RETURNING id, password_hash`,
						[row.name, row.email, (startHash ??= await hashPassword(DEFAULT_PASSWORD))]
					)
				).rows[0];
				console.log(`  ${row.email}: login created`);
			} else {
				await client.query('UPDATE plant_managers SET disabled_at = NULL WHERE id = $1', [
					manager.id
				]);
				if (!manager.password_hash)
					await client.query('UPDATE plant_managers SET password_hash = $1 WHERE id = $2', [
						(startHash ??= await hashPassword(DEFAULT_PASSWORD)),
						manager.id
					]);
			}
			const old = (
				await client.query<{ manager_id: string }>(
					'SELECT manager_id FROM plant_manager_assignments WHERE plant_id = $1',
					[plant.id]
				)
			).rows[0]?.manager_id;
			if (old === manager.id) {
				await client.query('COMMIT');
				continue;
			}
			await client.query(
				`INSERT INTO plant_manager_assignments (plant_id, manager_id, assigned_by)
				 VALUES ($1, $2, $3)
				 ON CONFLICT (plant_id) DO UPDATE SET manager_id = EXCLUDED.manager_id,
				 assigned_by = EXCLUDED.assigned_by, assigned_at = now()`,
				[plant.id, manager.id, admin?.id ?? null]
			);
			await client.query('UPDATE plants SET manager_name = $1, manager_email = $2 WHERE id = $3', [
				row.name,
				row.email,
				plant.id
			]);
			await client.query(
				`INSERT INTO plant_manager_assignment_history (plant_id, old_manager_id, new_manager_id, changed_by)
				 VALUES ($1, $2, $3, $4)`,
				[plant.id, old ?? null, manager.id, admin?.id ?? null]
			);
			await client.query('COMMIT');
			console.log(`  ${row.plant}: plant manager now ${row.name}`);
		} catch (error) {
			await client.query('ROLLBACK').catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}
}
