import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '$lib/server/db';
import { importCsv } from '$lib/server/csvImport';
import { logger } from '$lib/server/log';

export const POST: RequestHandler = async ({ request, locals }) => {
	const form = await request.formData();
	const file = form.get('file') as File | null;
	if (!file) return json({ error: 'file is required' }, { status: 400 });

	const csvText = await file.text();
	const summary = await importCsv(csvText);

	const record = await query<any>(
		`INSERT INTO csv_imports (admin_id, filename, rows_total, rows_created, rows_skipped, errors_json)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		[locals.user!.id, file.name, summary.rows_total, summary.rows_created, summary.rows_skipped, JSON.stringify(summary.errors)]
	);

	logger.info({ adminId: locals.user!.id, filename: file.name, summary }, 'csv import completed');

	return json({ import_id: record[0].id, ...summary });
};
