// Minimal migration runner: applies any new db/migrations/*.sql file in filename order,
// tracked in schema_migrations, idempotently. Run with: npx tsx scripts/migrate.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

async function main() {
	const pool = new Pool({ connectionString: process.env.DATABASE_URL });
	await pool.query(
		`CREATE TABLE IF NOT EXISTS schema_migrations (
		   filename TEXT PRIMARY KEY,
		   applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		 )`
	);

	const dir = path.join(process.cwd(), 'db', 'migrations');
	const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

	for (const file of files) {
		const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
		if (rows.length) {
			console.log(`skip (already applied): ${file}`);
			continue;
		}
		const sql = await fs.readFile(path.join(dir, file), 'utf-8');
		console.log(`applying: ${file}`);
		await pool.query(sql);
		await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
		console.log(`applied: ${file}`);
	}

	await pool.end();
	console.log('migrations complete');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
