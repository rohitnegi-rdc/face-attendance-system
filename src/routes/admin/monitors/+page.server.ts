import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { hashPassword } from '$lib/server/auth';
import { pool, query } from '$lib/server/db';
import { logger } from '$lib/server/log';
import { issueTemporaryPassword } from '$lib/server/passwordReset';

// Monitors watch every pump of the Areas they are given and fix attendance like a plant manager
// (manager_plants). A monitor is a plant-manager login marked is_monitor, so an existing plant
// manager can also be made a monitor with the same email.
const UUID = /^[0-9a-f-]{36}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const load: PageServerLoad = async () => {
	const [areas, monitors] = await Promise.all([
		query<any>(
			`SELECT a.id, a.name, count(pu.id)::int AS pumps
			 FROM areas a JOIN plants pl ON pl.area_id = a.id JOIN pumps pu ON pu.plant_id = pl.id
			 GROUP BY a.id ORDER BY a.name`
		),
		query<any>(
			`SELECT pm.id, pm.name, pm.email,
			        COALESCE(array_agg(ma.area_id) FILTER (WHERE ma.area_id IS NOT NULL), '{}') AS area_ids,
			        (SELECT count(*)::int FROM manager_plants mp JOIN pumps pu ON pu.plant_id = mp.plant_id
			          WHERE mp.manager_id = pm.id) AS pumps
			 FROM plant_managers pm LEFT JOIN monitor_areas ma ON ma.manager_id = pm.id
			 WHERE pm.is_monitor GROUP BY pm.id ORDER BY pm.name, pm.email`
		)
	]);
	return { areas, monitors };
};

function areaIds(form: FormData) {
	return [...new Set(form.getAll('area_id').map(String))].filter((id) => UUID.test(id));
}

// The monitor's Areas become exactly `ids`.
async function setAreas(client: PoolClient, managerId: string, ids: string[], adminId: string) {
	await client.query(
		'DELETE FROM monitor_areas WHERE manager_id = $1 AND NOT (area_id = ANY($2))',
		[managerId, ids]
	);
	await client.query(
		`INSERT INTO monitor_areas (manager_id, area_id, assigned_by)
		 SELECT $1, a.id, $3 FROM areas a WHERE a.id = ANY($2)
		 ON CONFLICT (manager_id, area_id) DO NOTHING`,
		[managerId, ids, adminId]
	);
}

async function audit(
	client: PoolClient,
	adminId: string,
	action: string,
	id: string,
	details: object
) {
	await client.query(
		`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
		 VALUES ($1, $2, 'monitor', $3, $4)`,
		[adminId, action, id, JSON.stringify(details)]
	);
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

export const actions: Actions = {
	add: async ({ request, locals }) => {
		const form = await request.formData();
		const name = String(form.get('name') || '')
			.trim()
			.slice(0, 200);
		const email = String(form.get('email') || '')
			.trim()
			.toLowerCase();
		const ids = areaIds(form);
		if (!EMAIL.test(email)) return fail(400, { formKind: 'add', message: 'Enter a valid email.' });
		if (!ids.length) return fail(400, { formKind: 'add', message: 'Pick at least one area.' });
		const adminId = locals.user!.id;
		try {
			const result = await inTransaction(async (client) => {
				const taken = await client.query(
					`SELECT 1 FROM admins WHERE lower(email) = $1
					 UNION ALL SELECT 1 FROM vendors WHERE lower(email) = $1
					 UNION ALL SELECT 1 FROM pumps WHERE lower(login_email) = $1 LIMIT 1`,
					[email]
				);
				if (taken.rowCount)
					return { error: 'That email is already used by an admin, vendor or pump.' };
				const existing = await client.query(
					'SELECT id, name FROM plant_managers WHERE lower(email) = $1 FOR UPDATE',
					[email]
				);
				let manager = existing.rows[0];
				let password: string | null = null;
				if (!manager) {
					if (!name) return { error: 'Enter a name for the new monitor.' };
					password = randomBytes(12).toString('base64url');
					const inserted = await client.query(
						`INSERT INTO plant_managers (name, email, password_hash, is_monitor)
						 VALUES ($1, $2, $3, true) RETURNING id, name`,
						[name, email, await hashPassword(password)]
					);
					manager = inserted.rows[0];
				} else {
					await client.query(
						`UPDATE plant_managers SET is_monitor = true, disabled_at = NULL,
						 name = COALESCE(NULLIF($2, ''), name)
						 WHERE id = $1`,
						[manager.id, name]
					);
				}
				await setAreas(client, manager.id, ids, adminId);
				await audit(client, adminId, 'monitor_add', manager.id, {
					areas: ids,
					created: Boolean(password)
				});
				return { name: name || manager.name, password };
			});
			if ('error' in result) return fail(400, { formKind: 'add', message: result.error });
			logger.info({ adminId, areas: ids.length }, 'monitor added');
			return {
				formKind: 'add',
				success: true,
				message: `${result.name} now monitors ${ids.length} ${ids.length === 1 ? 'area' : 'areas'}.`,
				credentials: result.password ? { email, password: result.password } : null
			};
		} catch (error: any) {
			if (error?.code === '23505')
				return fail(409, {
					formKind: 'add',
					message: 'This email was added at the same time. Refresh.'
				});
			logger.error({ adminId, error: String(error?.message || error) }, 'monitor add failed');
			return fail(500, { formKind: 'add', message: 'Could not add the monitor.' });
		}
	},
	areas: async ({ request, locals }) => {
		const form = await request.formData();
		const id = String(form.get('id') || '');
		const ids = areaIds(form);
		if (!UUID.test(id)) return fail(404, { formKind: 'row', id, message: 'Monitor not found.' });
		if (!ids.length)
			return fail(400, {
				formKind: 'row',
				id,
				message: 'Keep at least one area, or remove the monitor.'
			});
		const found = await inTransaction(async (client) => {
			const { rowCount } = await client.query(
				'SELECT 1 FROM plant_managers WHERE id = $1 AND is_monitor FOR UPDATE',
				[id]
			);
			if (!rowCount) return false;
			await setAreas(client, id, ids, locals.user!.id);
			await audit(client, locals.user!.id, 'monitor_areas', id, { areas: ids });
			return true;
		});
		if (!found) return fail(404, { formKind: 'row', id, message: 'Monitor not found.' });
		return { formKind: 'row', id, success: true, message: 'Areas saved.' };
	},
	// No longer a monitor: their Areas go and the login can no longer sign in. A login that also
	// manages plants keeps those and its sign-in.
	remove: async ({ request, locals }) => {
		const id = String((await request.formData()).get('id') || '');
		if (!UUID.test(id)) return fail(404, { formKind: 'row', id, message: 'Monitor not found.' });
		const keepsPlants = await inTransaction(async (client) => {
			await client.query('DELETE FROM monitor_areas WHERE manager_id = $1', [id]);
			const { rows } = await client.query(
				`UPDATE plant_managers SET is_monitor = false,
				   disabled_at = CASE WHEN EXISTS (SELECT 1 FROM plant_manager_assignments WHERE manager_id = $1)
				     THEN disabled_at ELSE now() END
				 WHERE id = $1 RETURNING disabled_at IS NULL AS keeps_plants`,
				[id]
			);
			const keeps = Boolean(rows[0]?.keeps_plants);
			await audit(client, locals.user!.id, 'monitor_remove', id, { sign_in_blocked: !keeps });
			return keeps;
		});
		return {
			formKind: 'list',
			success: true,
			message: keepsPlants
				? 'Monitor removed. The login still manages its own plants.'
				: 'Monitor removed. They can no longer sign in.'
		};
	},
	resetPassword: async ({ request, locals }) => {
		const id = String((await request.formData()).get('id') || '');
		const issued = UUID.test(id)
			? await issueTemporaryPassword('plant-manager', id, { role: 'admin', id: locals.user!.id })
			: null;
		if (!issued) return fail(404, { formKind: 'row', id, message: 'Monitor not found.' });
		return {
			formKind: 'row',
			id,
			success: true,
			message: 'Temporary password issued. It is shown once; they choose their own at sign-in.',
			credentials: issued
		};
	}
};
