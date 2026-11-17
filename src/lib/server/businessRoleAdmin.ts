// The admin page for business managers (/admin/business-managers) and business heads
// (/admin/business-heads, migration 051): one per plant, uploaded as a CSV (Name, Email, Plant,
// Plant Code) or changed one plant at a time. Business managers approve missed days; business
// heads only look and are copied on the 9 am email. Every change is audited.
import { fail, type Actions } from '@sveltejs/kit';
import type { PoolClient } from 'pg';
import { pool, query } from '$lib/server/db';
import { logger } from '$lib/server/log';
import {
	ROLE_TABLES,
	importBusinessManagers,
	listBusinessManagers,
	parseBusinessManagerCsv,
	type BusinessRole
} from '$lib/server/businessManagers';

// Words per role for the messages.
const WORDS = {
	manager: {
		one: 'business manager',
		many: 'business managers',
		audit: 'business_manager',
		gone: "Their plants' requests now go to the admins.",
		plantGone: 'Plant removed. Its requests now go to the admins.'
	},
	head: {
		one: 'business head',
		many: 'business heads',
		audit: 'business_head',
		gone: 'Their plants have no business head now.',
		plantGone: 'Plant removed from its business head.'
	}
} as const;

const UUID = /^[0-9a-f-]{36}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function roleAdminLoad(role: BusinessRole) {
	return async () => {
		const [list, plants] = await Promise.all([
			listBusinessManagers(role),
			query<{ id: string; name: string; area_name: string }>(
				`SELECT pl.id, pl.name, a.name AS area_name FROM plants pl JOIN areas a ON a.id = pl.area_id
			 ORDER BY a.name, pl.name`
			)
		]);
		return {
			...list,
			plants: plants.map((p) => ({ id: p.id, name: p.name, areaName: p.area_name }))
		};
	};
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const result = await work(client);
		await client.query('COMMIT');
		return result;
	} catch (error) {
		await client.query('ROLLBACK').catch(() => {});
		throw error;
	} finally {
		client.release();
	}
}

async function audit(
	client: PoolClient,
	role: BusinessRole,
	adminId: string,
	action: string,
	id: string | null,
	details: object
) {
	await client.query(
		`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
		 VALUES ($1, $2, $3, $4, $5)`,
		[adminId, `${WORDS[role].audit}_${action}`, WORDS[role].audit, id, JSON.stringify(details)]
	);
}

export function roleAdminActions(role: BusinessRole): Actions {
	const t = ROLE_TABLES[role];
	const w = WORDS[role];
	return {
		upload: async ({ request, locals }) => {
			const form = await request.formData();
			const file = form.get('file');
			if (!(file instanceof File) || file.size === 0)
				return fail(400, { formKind: 'upload', message: 'Choose a CSV file.' });
			if (file.size > 1024 * 1024)
				return fail(400, { formKind: 'upload', message: 'The file is larger than 1 MB.' });
			let rows;
			try {
				rows = parseBusinessManagerCsv(await file.text(), role);
			} catch {
				return fail(400, { formKind: 'upload', message: 'This file is not a readable CSV.' });
			}
			if (!rows.length) return fail(400, { formKind: 'upload', message: 'The file has no rows.' });
			const adminId = locals.user!.id;
			const summary = await inTransaction(async (client) => {
				const result = await importBusinessManagers(client, rows, adminId, role);
				await audit(client, role, adminId, 'import', null, result);
				return result;
			});
			logger.info({ adminId, ...summary, errors: summary.errors.length }, `${w.many} imported`);
			return {
				formKind: 'upload',
				success: summary.errors.length === 0,
				message: `${summary.managers} ${w.many}, ${summary.assigned} plants given, ${summary.waiting} waiting for their plant.`,
				errors: summary.errors
			};
		},

		// Gives a plant to a business manager: an existing one (manager_id) or a new one (name + email).
		assign: async ({ request, locals }) => {
			const form = await request.formData();
			const plantId = String(form.get('plant_id') || '');
			const managerId = String(form.get('manager_id') || '');
			const name = String(form.get('name') || '')
				.trim()
				.slice(0, 200);
			const email = String(form.get('email') || '')
				.trim()
				.toLowerCase();
			if (!UUID.test(plantId)) return fail(400, { formKind: 'assign', message: 'Pick a plant.' });
			if (!UUID.test(managerId) && (!name || !EMAIL.test(email)))
				return fail(400, {
					formKind: 'assign',
					message: `Pick a ${w.one}, or enter the name and email of a new one.`
				});
			const adminId = locals.user!.id;
			const result = await inTransaction(async (client) => {
				let id = managerId;
				if (!UUID.test(managerId)) {
					const taken = await client.query(
						`SELECT 1 FROM admins WHERE lower(email) = $1
					 UNION ALL SELECT 1 FROM vendors WHERE lower(email) = $1
					 UNION ALL SELECT 1 FROM pumps WHERE lower(login_email) = $1 LIMIT 1`,
						[email]
					);
					if (taken.rowCount)
						return { error: 'That email is already an admin, vendor or pump login.' };
					const row = await client.query(
						`INSERT INTO plant_managers (name, email, password_hash, must_change_password, ${t.flag})
					 VALUES ($1, $2, NULL, FALSE, true)
					 ON CONFLICT (lower(email)) DO UPDATE SET ${t.flag} = true, disabled_at = NULL
					 RETURNING id`,
						[name, email]
					);
					id = row.rows[0].id;
				} else {
					const row = await client.query(
						`SELECT 1 FROM plant_managers WHERE id = $1 AND ${t.flag} AND disabled_at IS NULL`,
						[id]
					);
					if (!row.rowCount) return { error: `That ${w.one} is no longer on the list.` };
				}
				const plant = await client.query('SELECT name FROM plants WHERE id = $1', [plantId]);
				if (!plant.rowCount) return { error: 'That plant no longer exists.' };
				const before = await client.query(
					`SELECT manager_id FROM ${t.plants} WHERE plant_id = $1`,
					[plantId]
				);
				await client.query(
					`INSERT INTO ${t.plants} (plant_id, manager_id, assigned_by) VALUES ($1, $2, $3)
				 ON CONFLICT (plant_id) DO UPDATE SET manager_id = EXCLUDED.manager_id,
				   assigned_by = EXCLUDED.assigned_by, assigned_at = now()`,
					[plantId, id, adminId]
				);
				await audit(client, role, adminId, 'assign', id, {
					plantId,
					previous: before.rows[0]?.manager_id ?? null
				});
				return { plant: plant.rows[0].name as string };
			});
			if ('error' in result) return fail(400, { formKind: 'assign', message: result.error });
			return {
				formKind: 'assign',
				success: true,
				message: `${result.plant} has its ${w.one}.`
			};
		},

		// Takes one plant away: its requests go to the admins until it has a business manager again.
		unassign: async ({ request, locals }) => {
			const form = await request.formData();
			const plantId = String(form.get('plant_id') || '');
			if (!UUID.test(plantId)) return fail(400, { formKind: 'row', message: 'Pick a plant.' });
			const adminId = locals.user!.id;
			await inTransaction(async (client) => {
				const row = await client.query(
					`DELETE FROM ${t.plants} WHERE plant_id = $1 RETURNING manager_id`,
					[plantId]
				);
				if (row.rowCount)
					await audit(client, role, adminId, 'unassign', row.rows[0].manager_id, {
						plantId
					});
			});
			return {
				formKind: 'row',
				success: true,
				message: w.plantGone
			};
		},

		// Removes a business manager: their plants go to the admins. The login stops signing in unless
		// it also manages plants or is a monitor. Decisions already made stay in the history.
		remove: async ({ request, locals }) => {
			const form = await request.formData();
			const id = String(form.get('id') || '');
			if (!UUID.test(id)) return fail(400, { formKind: 'row', message: `Pick a ${w.one}.` });
			const adminId = locals.user!.id;
			const name = await inTransaction(async (client) => {
				const row = await client.query(
					`UPDATE plant_managers SET ${t.flag} = false,
				   disabled_at = CASE WHEN is_monitor
				     OR ${role === 'manager' ? 'is_business_head' : 'is_business_manager'}
				     OR EXISTS (SELECT 1 FROM plant_manager_assignments a WHERE a.manager_id = plant_managers.id)
				     THEN disabled_at ELSE now() END
				 WHERE id = $1 AND ${t.flag} RETURNING name`,
					[id]
				);
				if (!row.rowCount) return null;
				const plants = await client.query(
					`DELETE FROM ${t.plants} WHERE manager_id = $1 RETURNING plant_id`,
					[id]
				);
				await client.query(`DELETE FROM ${t.waiting} WHERE manager_id = $1`, [id]);
				await audit(client, role, adminId, 'remove', id, {
					plants: plants.rows.map((r) => r.plant_id)
				});
				return row.rows[0].name as string;
			});
			if (!name) return fail(404, { formKind: 'row', message: 'Already removed.' });
			logger.info({ adminId, managerId: id }, `${w.one} removed`);
			return {
				formKind: 'row',
				success: true,
				message: `${name} removed. ${w.gone}`
			};
		}
	};
}
