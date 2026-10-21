// Minimal migration runner: applies any new db/migrations/*.sql or *.ts file in filename order,
// tracked in schema_migrations, idempotently. Run with: npx tsx scripts/migrate.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
	const files = (await fs.readdir(dir)).filter((f) => /\.(sql|ts)$/.test(f)).sort();

	for (const file of files) {
		const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [
			file
		]);
		if (rows.length) {
			console.log(`skip (already applied): ${file}`);
			continue;
		}
		console.log(`applying: ${file}`);
		if (file.endsWith('.ts')) {
			// Data migration: its default export runs app code (e.g. the CSV importer) through the
			// app's own pool, so it is not one transaction. It must be safe to rerun if it fails part way.
			const { default: up } = await import(pathToFileURL(path.join(dir, file)).href);
			await up();
			await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
			console.log(`applied: ${file}`);
			continue;
		}
		const sql = await fs.readFile(path.join(dir, file), 'utf-8');
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await client.query(sql);
			await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
			await client.query('COMMIT');
		} catch (error) {
			await client.query('ROLLBACK').catch(() => {});
			throw error;
		} finally {
			client.release();
		}
		console.log(`applied: ${file}`);
	}

	await pool.end();
	console.log('migrations complete');
}

// Exit explicitly: a .ts data migration leaves the app's own pool open.
main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
