import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const { Pool } = pg;
const apply = process.argv.includes('--apply');
const csvPath = process.argv.find((arg) => arg.startsWith('--csv='))?.slice(6) ?? 'Plant Managers.csv';
const credentialsPath = process.argv.find((arg) => arg.startsWith('--credentials='))?.slice(14);
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://attendance:attendance@localhost:6101/attendance';
const pool = new Pool({ connectionString: databaseUrl });

const normalize = (value: string) => value.toLowerCase().replace(/\./g, '').replace(/[^a-z0-9]+/g, '');
const password = () => randomBytes(18).toString('base64url');

interface ManagerRow {
	plantCode: string;
	plantName: string;
	name: string;
	email: string;
	line: number;
}

async function main() {
	const { readFile } = await import('node:fs/promises');
	const csv = await readFile(csvPath, 'utf8');
	const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
	const managers: ManagerRow[] = rows.map((row, index) => ({
		plantCode: (row['Plant Code'] ?? '').trim(),
		plantName: (row['Plant Name'] ?? '').trim(),
		name: (row['Plant Manager Name'] ?? '').trim(),
		email: (row['Email ID'] ?? '').trim().toLowerCase(),
		line: index + 2
	})).filter((row) => row.plantName || row.email);

	const client = await pool.connect();
	try {
		const dbPlants = (await client.query('SELECT id, name, external_code FROM plants')).rows as {
			id: string; name: string; external_code: string | null;
		}[];
		const byCode = new Map<string, typeof dbPlants>();
		const byName = new Map<string, typeof dbPlants>();
		for (const plant of dbPlants) {
			if (plant.external_code) byCode.set(plant.external_code.trim().toLowerCase(), [...(byCode.get(plant.external_code.trim().toLowerCase()) ?? []), plant]);
			const key = normalize(plant.name);
			byName.set(key, [...(byName.get(key) ?? []), plant]);
		}

		const issues: string[] = [];
		const unmatched: string[] = [];
		const mappings = new Map<string, ManagerRow>();
		for (const row of managers) {
			if (!row.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) issues.push(`CSV line ${row.line}: invalid/missing email (${row.email || 'blank'})`);
			if (!row.name) issues.push(`CSV line ${row.line}: manager name is blank`);
			const codeMatches = row.plantCode ? byCode.get(row.plantCode.toLowerCase()) ?? [] : [];
			const candidates = codeMatches.length ? codeMatches : byName.get(normalize(row.plantName)) ?? [];
			if (candidates.length !== 1) {
				const message = `CSV line ${row.line}: ${candidates.length ? 'ambiguous' : 'unmatched'} plant ${row.plantCode} ${row.plantName}`;
				(candidates.length ? issues : unmatched).push(message);
				continue;
			}
			const plantId = candidates[0].id;
			const previous = mappings.get(plantId);
			if (previous && previous.email !== row.email) issues.push(`CSV line ${row.line}: conflicting managers for ${row.plantName}`);
			else mappings.set(plantId, row);
		}
		if (!mappings.size) issues.push('CSV contains no plants that match the current database');

		const emails = new Map<string, string>();
		for (const row of mappings.values()) {
			const existingName = emails.get(row.email);
			if (existingName && normalize(existingName) !== normalize(row.name)) issues.push(`Email ${row.email} has multiple manager names (${existingName} / ${row.name})`);
			emails.set(row.email, row.name);
		}
		const conflicts = await client.query(
			`SELECT email FROM admins WHERE lower(email) = ANY($1::text[])
			 UNION SELECT email FROM vendors WHERE lower(email) = ANY($1::text[])
			 UNION SELECT login_email FROM pumps WHERE lower(login_email) = ANY($1::text[])`,
			[[...emails.keys()]]
		);
		for (const row of conflicts.rows) issues.push(`Email ${row.email} already belongs to another role`);

		const accountCount = await client.query('SELECT count(*)::int AS count FROM plant_managers');
		console.log(`CSV manager rows: ${managers.length}; unique managers for matched plants: ${emails.size}; clean plant mappings: ${mappings.size}; unmatched CSV plants: ${unmatched.length}; existing manager accounts: ${accountCount.rows[0].count}`);
		if (unmatched.length) {
			console.warn('These CSV plants are not in the current database and will not be assigned:');
			for (const item of unmatched) console.warn(`- ${item}`);
		}
		if (issues.length) {
			console.error(`Refusing to proceed; ${issues.length} issue(s):`);
			for (const issue of issues) console.error(`- ${issue}`);
			process.exitCode = 2;
			return;
		}
		if (!apply) {
			console.log('Dry run only. Review matches above; pass --apply to create accounts and assignments.');
			return;
		}

		const issued: { name: string; email: string; password: string }[] = [];
		await client.query('BEGIN');
		try {
			const admin = await client.query('SELECT id FROM admins ORDER BY created_at LIMIT 1');
			const adminId = admin.rows[0]?.id ?? null;
			const managerByEmail = new Map<string, { id: string; name: string }>();
			for (const [email, name] of emails) {
				let existing = await client.query('SELECT id, name, password_hash FROM plant_managers WHERE lower(email) = $1 FOR UPDATE', [email]);
				let managerRecord: { id: string; name: string };
				if (!existing.rows[0]) {
					const issuedPassword = password();
					const hash = await bcrypt.hash(issuedPassword, 10);
					const inserted = await client.query(
						'INSERT INTO plant_managers (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name',
						[name, email, hash]
					);
					managerRecord = inserted.rows[0];
					issued.push({ name, email, password: issuedPassword });
				} else if (!existing.rows[0].password_hash) {
					const issuedPassword = password();
					const hash = await bcrypt.hash(issuedPassword, 10);
					await client.query('UPDATE plant_managers SET name = $1, password_hash = $2 WHERE id = $3', [name, hash, existing.rows[0].id]);
					managerRecord = { id: existing.rows[0].id, name };
					issued.push({ name, email, password: issuedPassword });
				} else {
					await client.query('UPDATE plant_managers SET name = $1 WHERE id = $2', [name, existing.rows[0].id]);
					managerRecord = { id: existing.rows[0].id, name };
				}
				managerByEmail.set(email, managerRecord);
			}

			for (const [plantId, row] of mappings) {
				const manager = managerByEmail.get(row.email)!;
				const old = await client.query('SELECT manager_id FROM plant_manager_assignments WHERE plant_id = $1 FOR UPDATE', [plantId]);
				await client.query(
					`INSERT INTO plant_manager_assignments (plant_id, manager_id, assigned_by) VALUES ($1, $2, $3)
					 ON CONFLICT (plant_id) DO UPDATE SET manager_id = EXCLUDED.manager_id, assigned_by = EXCLUDED.assigned_by, assigned_at = now()`,
					[plantId, manager.id, adminId]
				);
				await client.query('UPDATE plants SET external_code = $1, manager_name = $2, manager_email = $3 WHERE id = $4', [row.plantCode || null, manager.name, row.email, plantId]);
				if (old.rows[0]?.manager_id !== manager.id) {
					await client.query('INSERT INTO plant_manager_assignment_history (plant_id, old_manager_id, new_manager_id, changed_by) VALUES ($1, $2, $3, $4)', [plantId, old.rows[0]?.manager_id ?? null, manager.id, adminId]);
				}
			}
			await client.query('COMMIT');
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		}

		if (issued.length) {
			const path = credentialsPath ?? `${process.env.TEMP ?? process.env.TMP ?? '.'}/plant-manager-logins-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
			await writeFile(path, `${JSON.stringify({ created_at: new Date().toISOString(), accounts: issued }, null, 2)}\n`, { flag: 'wx' });
			console.log(`Created ${issued.length} account(s). Temporary passwords saved to: ${path}`);
		} else {
			console.log('No new credentials were needed; all manager accounts already had passwords.');
		}
		console.log(`Assigned ${mappings.size} plant(s) to ${emails.size} unique manager account(s).`);
	} finally {
		client.release();
		await pool.end();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
