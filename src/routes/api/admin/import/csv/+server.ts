import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '$lib/server/db';
import { importCsv } from '$lib/server/csvImport';
import { logger } from '$lib/server/log';

export const POST: RequestHandler = async ({ request, locals }) => {
	const form = await request.formData();
	const file = form.get('file') as File | null;
	if (!file) return json({ error: 'file is required' }, { status: 400 });
	if (!file.name.toLowerCase().endsWith('.csv')) {
		return json({ error: 'Choose a CSV file.' }, { status: 400 });
	}
	if (file.size > 5 * 1024 * 1024) {
		return json({ error: 'The CSV file must be 5 MB or smaller.' }, { status: 413 });
	}

	const csvText = await file.text();
	let summary;
	try {
		summary = await importCsv(csvText);
	} catch {
		return json(
			{ error: 'The CSV could not be read. Check the header row and comma-separated format.' },
			{ status: 400 }
		);
	}

	const record = await query<any>(
		`INSERT INTO csv_imports (admin_id, filename, rows_total, rows_created, rows_skipped, errors_json)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		[
			locals.user!.id,
			file.name,
			summary.rows_total,
			summary.rows_created,
			summary.rows_skipped,
			JSON.stringify(summary.errors)
		]
	);

	logger.info({ adminId: locals.user!.id, filename: file.name, summary }, 'csv import completed');

	return json({ import_id: record[0].id, ...summary });
};
