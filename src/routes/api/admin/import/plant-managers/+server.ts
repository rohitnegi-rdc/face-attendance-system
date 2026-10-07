import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { importPlantManagers } from '$lib/server/plantManagerImport';
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
		summary = await importPlantManagers(csvText);
	} catch {
		return json(
			{
				error:
					'The CSV could not be read. Check the header row (Plant Code, Plant Name, Plant Manager Name, Email ID) and comma-separated format.'
			},
			{ status: 400 }
		);
	}

	logger.info(
		{ adminId: locals.user!.id, filename: file.name, summary },
		'plant manager import completed'
	);

	return json(summary);
};
