// Business managers (migration 048): one per plant, they approve regularisations
// (src/lib/server/regularisation.ts). Each is a plant-manager login marked is_business_manager that
// signs in with Google like plant managers (no password); its plants are in business_manager_plants
// and so appear on its plant-manager pages (manager_plants), read only unless it also manages
// plants of its own. A list row whose plant is not in the system yet waits in
// business_manager_waiting and joins its plant once the plant exists.
// Business heads (migration 051) are the same shape: is_business_head, business_head_plants and
// business_head_waiting; they see their plants read only, decide nothing, and are copied on the
// 9 am email of their plants' Areas. Every function takes the role ('manager' or 'head').
// Relative imports only: migrations 049 and 052 run this outside SvelteKit.
import type { PoolClient } from 'pg';
import { parse } from 'csv-parse/sync';
import { pool } from './db';
import { normalizePlantName } from './plantManagerImport';
import { attachWaitingSql } from '../../../worker/regularisationEmail.js';

export type BusinessRole = 'manager' | 'head';
// Table and column names per role: fixed strings, never user input.
export const ROLE_TABLES = {
	manager: {
		flag: 'is_business_manager',
		plants: 'business_manager_plants',
		waiting: 'business_manager_waiting',
		column: 'business manager'
	},
	head: {
		flag: 'is_business_head',
		plants: 'business_head_plants',
		waiting: 'business_head_waiting',
		column: 'business head'
	}
} as const;

export type BusinessManagerRow = { name: string; email: string; plant: string; code: string };
export type ImportSummary = {
	managers: number;
	assigned: number;
	waiting: number;
	errors: string[];
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Columns: Business Manager (or Business Head), Email, Plant (or Plant Name), Plant Code.
export function parseBusinessManagerCsv(
	text: string,
	role: BusinessRole = 'manager'
): BusinessManagerRow[] {
	const column = ROLE_TABLES[role].column;
	const records: Record<string, string>[] = parse(text.replace(/^\uFEFF/, ''), {
		columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
		skip_empty_lines: true,
		trim: true,
		relax_column_count: true
	});
	return records.map((r) => ({
		name: r[column] ?? r['name'] ?? '',
		email: (r['email'] ?? r[`${column} email`] ?? r['email id'] ?? '').toLowerCase(),
		plant: r['plant'] ?? r['plant name'] ?? '',
		code: r['plant code'] ?? r['code'] ?? ''
	}));
}

// Adds or moves every row: the list is the truth for the plants it names, so a plant listed under
// another business manager moves to this one. Run inside the caller's transaction.
export async function importBusinessManagers(
	client: PoolClient,
	rows: BusinessManagerRow[],
	adminId: string | null,
	role: BusinessRole = 'manager'
): Promise<ImportSummary> {
	const t = ROLE_TABLES[role];
	const plants = (await client.query('SELECT id, name, external_code FROM plants')).rows as {
		id: string;
		name: string;
		external_code: string | null;
	}[];
	const byCode = new Map<string, string[]>();
	const byName = new Map<string, string[]>();
	for (const plant of plants) {
		if (plant.external_code) {
			byCode.set(plant.external_code, [...(byCode.get(plant.external_code) ?? []), plant.id]);
		}
		const key = normalizePlantName(plant.name);
		byName.set(key, [...(byName.get(key) ?? []), plant.id]);
	}
	const managers = new Set<string>();
	const summary: ImportSummary = { managers: 0, assigned: 0, waiting: 0, errors: [] };
	for (const [index, row] of rows.entries()) {
		const line = index + 2;
		const name = row.name.trim().slice(0, 200);
		const email = row.email.trim().toLowerCase();
		const code = row.code.trim();
		if (!name || !EMAIL.test(email) || (!row.plant.trim() && !code)) {
			summary.errors.push(`Row ${line}: needs a name, a valid email and a plant`);
			continue;
		}
		const taken = await client.query(
			`SELECT 1 FROM admins WHERE lower(email) = $1
			 UNION ALL SELECT 1 FROM vendors WHERE lower(email) = $1
			 UNION ALL SELECT 1 FROM pumps WHERE lower(login_email) = $1 LIMIT 1`,
			[email]
		);
		if (taken.rowCount) {
			summary.errors.push(`Row ${line}: ${email} is already an admin, vendor or pump login`);
			continue;
		}
		const manager = await client.query(
			`INSERT INTO plant_managers (name, email, password_hash, must_change_password, ${t.flag})
			 VALUES ($1, $2, NULL, FALSE, true)
			 ON CONFLICT (lower(email)) DO UPDATE SET ${t.flag} = true, disabled_at = NULL
			 RETURNING id`,
			[name, email]
		);
		const managerId = manager.rows[0].id as string;
		managers.add(managerId);
		const byCodeIds = code ? (byCode.get(code) ?? []) : [];
		const byNameIds = byName.get(normalizePlantName(row.plant)) ?? [];
		const plantId =
			byCodeIds.length === 1 ? byCodeIds[0] : byNameIds.length === 1 ? byNameIds[0] : null;
		if (!plantId) {
			const key = code || `name:${normalizePlantName(row.plant)}`;
			await client.query(
				`INSERT INTO ${t.waiting} (plant_code, plant_name, manager_id)
				 VALUES ($1, $2, $3)
				 ON CONFLICT (plant_code) DO UPDATE SET plant_name = EXCLUDED.plant_name,
				   manager_id = EXCLUDED.manager_id, added_at = now()`,
				[key, row.plant.trim() || key, managerId]
			);
			summary.waiting++;
			continue;
		}
		await client.query(
			`INSERT INTO ${t.plants} (plant_id, manager_id, assigned_by)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (plant_id) DO UPDATE SET manager_id = EXCLUDED.manager_id,
			   assigned_by = EXCLUDED.assigned_by, assigned_at = now()
			 WHERE ${t.plants}.manager_id <> EXCLUDED.manager_id`,
			[plantId, managerId, adminId]
		);
		if (code) {
			await client.query(
				'UPDATE plants SET external_code = $1 WHERE id = $2 AND external_code IS NULL',
				[code, plantId]
			);
			await client.query(`DELETE FROM ${t.waiting} WHERE plant_code = $1`, [code]);
		}
		summary.assigned++;
	}
	summary.managers = managers.size;
	return summary;
}

// Rows waiting for a plant that has since been added join it.
export async function attachWaitingPlants(
	db: PoolClient | typeof pool = pool,
	role: BusinessRole = 'manager'
) {
	await db.query(attachWaitingSql(ROLE_TABLES[role].plants, ROLE_TABLES[role].waiting));
}

export type BusinessManagerView = {
	id: string;
	name: string;
	email: string;
	plants: { id: string; name: string; areaName: string; code: string | null; pumps: number }[];
	waiting: { code: string; name: string }[];
};

export async function listBusinessManagers(role: BusinessRole = 'manager') {
	const t = ROLE_TABLES[role];
	await attachWaitingPlants(pool, role);
	const managers = (
		await pool.query(
			`SELECT pm.id, pm.name, pm.email FROM plant_managers pm
			 WHERE pm.${t.flag} AND pm.disabled_at IS NULL ORDER BY pm.name, pm.email`
		)
	).rows as { id: string; name: string; email: string }[];
	const plants = (
		await pool.query(
			`SELECT b.manager_id, pl.id, pl.name, a.name AS area_name, pl.external_code AS code,
			        (SELECT count(*)::int FROM pumps pu WHERE pu.plant_id = pl.id) AS pumps
			 FROM ${t.plants} b JOIN plants pl ON pl.id = b.plant_id
			 JOIN areas a ON a.id = pl.area_id ORDER BY a.name, pl.name`
		)
	).rows;
	const waiting = (
		await pool.query(
			`SELECT manager_id, plant_code AS code, plant_name AS name FROM ${t.waiting} ORDER BY plant_name`
		)
	).rows;
	const unassigned = (
		await pool.query(
			`SELECT pl.id, pl.name, a.name AS area_name, count(pu.id)::int AS pumps
			 FROM plants pl JOIN areas a ON a.id = pl.area_id JOIN pumps pu ON pu.plant_id = pl.id
			 WHERE NOT EXISTS (SELECT 1 FROM ${t.plants} b WHERE b.plant_id = pl.id)
			 GROUP BY pl.id, a.name ORDER BY a.name, pl.name`
		)
	).rows as { id: string; name: string; area_name: string; pumps: number }[];
	const view: BusinessManagerView[] = managers.map((m) => ({
		...m,
		plants: plants
			.filter((p) => p.manager_id === m.id)
			.map((p) => ({
				id: p.id,
				name: p.name,
				areaName: p.area_name,
				code: p.code,
				pumps: p.pumps
			})),
		waiting: waiting
			.filter((w) => w.manager_id === m.id)
			.map((w) => ({ code: w.code.startsWith('name:') ? '' : w.code, name: w.name }))
	}));
	return {
		managers: view,
		unassigned: unassigned.map((p) => ({
			id: p.id,
			name: p.name,
			areaName: p.area_name,
			pumps: p.pumps
		}))
	};
}
