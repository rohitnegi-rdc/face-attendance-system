import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '$lib/server/auth';
import { pool, query } from '$lib/server/db';
import { logger } from '$lib/server/log';

function temporaryPassword() {
	return randomBytes(12).toString('base64url');
}

export const load: PageServerLoad = async () => {
	const [plants, managers] = await Promise.all([
		query<any>(
			`SELECT p.id, p.name AS plant_name, a.name AS area_name, p.manager_name AS contact_name,
			        p.manager_email AS contact_email, pm.id AS manager_id, pm.name AS manager_name,
			        pm.email AS manager_email, COUNT(DISTINCT pu.id)::int AS pump_count
			 FROM plants p JOIN areas a ON a.id = p.area_id
			 LEFT JOIN plant_manager_assignments pma ON pma.plant_id = p.id
			 LEFT JOIN plant_managers pm ON pm.id = pma.manager_id
			 LEFT JOIN pumps pu ON pu.plant_id = p.id
			 GROUP BY p.id, a.name, pm.id ORDER BY a.name, p.name`
		),
		query<any>(`SELECT id, name, email FROM plant_managers ORDER BY name, email`)
	]);
	return { plants, managers };
};

export const actions: Actions = {
	assign: async ({ request, locals }) => {
		const form = await request.formData();
		const plantId = String(form.get('plant_id') || '').trim();
		const name = String(form.get('manager_name') || '').trim();
		const email = String(form.get('manager_email') || '').trim().toLowerCase();
		if (!plantId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			return fail(400, { message: 'Choose a plant and provide a valid manager email.' });
		}

		const client = await pool.connect();
		let issuedPassword: string | null = null;
		try {
			await client.query('BEGIN');
			const conflictingAccount = await client.query(
				`SELECT email FROM admins WHERE lower(email) = $1
				 UNION ALL SELECT email FROM vendors WHERE lower(email) = $1
				 UNION ALL SELECT login_email AS email FROM pumps WHERE lower(login_email) = $1 LIMIT 1`,
				[email]
			);
			if (conflictingAccount.rows.length) {
				await client.query('ROLLBACK');
				return fail(409, { message: 'That email is already used by an admin, vendor, or pump account.' });
			}
			const plantResult = await client.query(
				' SELECT id, manager_name FROM plants WHERE id = $1 FOR UPDATE',
				[plantId]
			);
			if (!plantResult.rows[0]) {
				await client.query('ROLLBACK');
				return fail(404, { message: 'The selected plant was not found.' });
			}

			const managerResult = await client.query(
				'SELECT id, name, password_hash FROM plant_managers WHERE lower(email) = $1 FOR UPDATE',
				[email]
			);
			let manager = managerResult.rows[0];
			if (!manager) {
				if (!name) {
					await client.query('ROLLBACK');
					return fail(400, { message: 'Enter a manager name to create a new account.' });
				}
				issuedPassword = temporaryPassword();
				const passwordHash = await hashPassword(issuedPassword);
				const inserted = await client.query(
					`INSERT INTO plant_managers (name, email, password_hash) VALUES ($1, $2, $3)
					 RETURNING id, name`,
					[name, email, passwordHash]
				);
				manager = inserted.rows[0];
			} else {
				if (name) await client.query('UPDATE plant_managers SET name = $1 WHERE id = $2', [name, manager.id]);
				if (!manager.password_hash) {
					issuedPassword = temporaryPassword();
					const passwordHash = await hashPassword(issuedPassword);
					await client.query('UPDATE plant_managers SET password_hash = $1 WHERE id = $2', [passwordHash, manager.id]);
				}
			}
			const assignedManagerName = name || manager.name;

			const previous = await client.query(
				'SELECT manager_id FROM plant_manager_assignments WHERE plant_id = $1 FOR UPDATE',
				[plantId]
			);
			const oldManagerId = previous.rows[0]?.manager_id ?? null;
			await client.query(
				`INSERT INTO plant_manager_assignments (plant_id, manager_id, assigned_by)
				 VALUES ($1, $2, $3)
				 ON CONFLICT (plant_id) DO UPDATE SET manager_id = EXCLUDED.manager_id,
				 assigned_by = EXCLUDED.assigned_by, assigned_at = now()`,
				[plantId, manager.id, locals.user!.id]
			);
			await client.query(
				`UPDATE plants SET manager_name = $1, manager_email = $2 WHERE id = $3`,
				[assignedManagerName, email, plantId]
			);
			await client.query(
				`INSERT INTO plant_manager_assignment_history (plant_id, old_manager_id, new_manager_id, changed_by)
				 VALUES ($1, $2, $3, $4)`,
				[plantId, oldManagerId, manager.id, locals.user!.id]
			);
			await client.query('COMMIT');
			logger.info({ adminId: locals.user!.id, plantId, managerId: manager.id, oldManagerId }, 'plant manager assigned');
			return {
				success: true,
				message: `Plant manager ${assignedManagerName} assigned.`,
				credentials: issuedPassword ? { email, password: issuedPassword } : null
			};
		} catch (error: any) {
			await client.query('ROLLBACK').catch(() => {});
			if (error?.code === '23505') return fail(409, { message: 'A manager account with this email was created at the same time. Refresh and assign again.' });
			logger.error({ adminId: locals.user!.id, plantId, error: String(error?.message || error) }, 'plant manager assignment failed');
			return fail(500, { message: 'Could not save the plant manager assignment.' });
		} finally {
			client.release();
		}
	}
};
