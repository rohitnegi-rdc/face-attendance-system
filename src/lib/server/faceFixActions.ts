import { fail } from '@sveltejs/kit';
import type { PoolClient } from 'pg';
import { pool } from '$lib/server/db';
import { logger } from '$lib/server/log';
import { FaceFixError } from '$lib/server/faceFixes';

// Runs one admin face fix (faceFixes.ts) in its own transaction for a form action: a FaceFixError
// is shown to the admin as is, anything else rolls back with a plain message.
export async function runFaceFix(
	name: string,
	adminId: string,
	fix: (client: PoolClient) => Promise<string>
) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const message = await fix(client);
		await client.query('COMMIT');
		logger.warn({ adminId, fix: name }, 'admin face fix');
		return { success: true, message };
	} catch (fixError) {
		await client.query('ROLLBACK').catch(() => {});
		if (fixError instanceof FaceFixError)
			return fail(400, { success: false, message: fixError.message });
		logger.error({ adminId, fix: name, error: String(fixError) }, 'admin face fix failed');
		return fail(500, { success: false, message: 'Could not save the fix. Nothing was changed.' });
	} finally {
		client.release();
	}
}

export function formText(form: FormData, key: string) {
	return String(form.get(key) ?? '').trim();
}
