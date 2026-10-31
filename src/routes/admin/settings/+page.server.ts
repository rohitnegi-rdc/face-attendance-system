import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { pool, query } from '$lib/server/db';
import { logger } from '$lib/server/log';
import {
	ATTENDANCE_SETTING_DEFAULTS,
	ATTENDANCE_SETTING_LIMITS,
	DIGEST_CC_KEY,
	TEST_MODE_KEY,
	getAttendanceSettingsWithSource,
	getDigestCc,
	getDigestFirstDay,
	parseEmailList,
	getTestMode,
	validateAttendanceSettings,
	type AttendanceSettings
} from '$lib/server/settings';

export const load: PageServerLoad = async () => {
	const [settings, testMode, digestCc, digestFirstDay, digestAreas, auditLog] = await Promise.all([
		getAttendanceSettingsWithSource(),
		getTestMode(),
		getDigestCc(),
		getDigestFirstDay(),
		query<{ id: string; name: string; digest_enabled: boolean }>(
			'SELECT id, name, digest_enabled FROM areas ORDER BY name'
		),
		query<any>(
			`SELECT l.id, l.action, l.target_type, l.target_id, l.details, l.created_at, ad.email AS admin_email
			 FROM admin_audit_log l LEFT JOIN admins ad ON ad.id = l.admin_id
			 ORDER BY l.created_at DESC LIMIT 25`
		)
	]);
	return {
		settings,
		defaults: ATTENDANCE_SETTING_DEFAULTS,
		limits: ATTENDANCE_SETTING_LIMITS,
		testMode,
		digestCc,
		digestFirstDay,
		digestAreas,
		auditLog
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const form = await request.formData();
		const next: AttendanceSettings = {
			evening_min_gap_minutes: Number(form.get('evening_min_gap_minutes')),
			evening_pairing_window_hours: Number(form.get('evening_pairing_window_hours'))
		};
		const problem = validateAttendanceSettings(next);
		if (problem) return fail(400, { message: problem });

		const adminId = locals.user!.id;
		const previous = await getAttendanceSettingsWithSource();
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			for (const [key, value] of Object.entries(next)) {
				await client.query(
					`INSERT INTO app_settings (key, value, updated_by_admin_id, updated_at)
					 VALUES ($1, $2, $3, now())
					 ON CONFLICT (key) DO UPDATE
					 SET value = EXCLUDED.value, updated_by_admin_id = EXCLUDED.updated_by_admin_id,
					     updated_at = now()`,
					[key, String(value), adminId]
				);
			}
			await client.query(
				`INSERT INTO admin_audit_log (admin_id, action, target_type, details)
				 VALUES ($1, 'update_settings', 'app_settings', $2)`,
				[
					adminId,
					JSON.stringify({
						before: {
							evening_min_gap_minutes: previous.evening_min_gap_minutes.value,
							evening_pairing_window_hours: previous.evening_pairing_window_hours.value
						},
						after: next
					})
				]
			);
			await client.query('COMMIT');
		} catch (saveError) {
			await client.query('ROLLBACK').catch(() => {});
			logger.error({ adminId, error: String(saveError) }, 'settings save failed');
			return fail(500, { message: 'Could not save the settings. Nothing was changed.' });
		} finally {
			client.release();
		}
		logger.warn({ adminId, settings: next }, 'attendance settings changed');
		return { success: true, message: 'Settings saved. They apply to the next submission.' };
	},
	// Which Areas get the 9 am attendance email (areas.digest_enabled). None ticked sends nothing.
	digestAreas: async ({ request, locals }) => {
		const ticked = (await request.formData()).getAll('area').map(String);
		const adminId = locals.user!.id;
		const client = await pool.connect();
		let names: string[] = [];
		try {
			await client.query('BEGIN');
			const { rows: before } = await client.query(
				'SELECT name FROM areas WHERE digest_enabled ORDER BY name'
			);
			const { rows } = await client.query(
				`UPDATE areas SET digest_enabled = (id::text = ANY($1::text[]))
				 RETURNING name, digest_enabled`,
				[ticked]
			);
			names = rows
				.filter((r) => r.digest_enabled)
				.map((r) => r.name)
				.sort();
			await client.query(
				`INSERT INTO admin_audit_log (admin_id, action, target_type, details)
				 VALUES ($1, 'update_digest_areas', 'areas', $2)`,
				[adminId, JSON.stringify({ before: before.map((r) => r.name), after: names })]
			);
			await client.query('COMMIT');
		} catch (saveError) {
			await client.query('ROLLBACK').catch(() => {});
			logger.error({ adminId, error: String(saveError) }, 'digest areas save failed');
			return fail(500, { formKind: 'digest', message: 'Could not save. Nothing was changed.' });
		} finally {
			client.release();
		}
		return {
			formKind: 'digest',
			success: true,
			message: names.length
				? `Saved. The attendance email goes out for ${names.join(', ')}.`
				: 'Saved. No attendance email goes out until an area is ticked.'
		};
	},
	// Who is copied on every 9 am attendance email: the only source of its CC line. Add takes one
	// address or several (commas, spaces or new lines between them); Remove takes one.
	addDigestCc: async ({ request, locals }) => {
		const { emails, invalid } = parseEmailList(String((await request.formData()).get('cc') ?? ''));
		if (invalid.length)
			return fail(400, {
				formKind: 'digest-cc',
				message: `Not an email address: ${invalid.slice(0, 3).join(', ')}. Nothing was added.`
			});
		if (!emails.length)
			return fail(400, { formKind: 'digest-cc', message: 'Type an email address to add.' });
		const before = await getDigestCc();
		const added = emails.filter((email) => !before.includes(email));
		if (!added.length) return fail(400, { formKind: 'digest-cc', message: 'Already on the list.' });
		return saveDigestCc(
			locals.user!.id,
			before,
			[...before, ...added],
			`Added ${added.join(', ')}.`
		);
	},
	removeDigestCc: async ({ request, locals }) => {
		const email = String((await request.formData()).get('email') ?? '').toLowerCase();
		const before = await getDigestCc();
		if (!before.includes(email))
			return fail(400, { formKind: 'digest-cc', message: 'That address is not on the list.' });
		return saveDigestCc(
			locals.user!.id,
			before,
			before.filter((e) => e !== email),
			`Removed ${email}.`
		);
	},
	// Test mode on or off: the cross-pump fraud check and the attendance alert emails.
	testMode: async ({ request, locals }) => {
		const on = (await request.formData()).get('on') === 'true';
		const adminId = locals.user!.id;
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			if (on) {
				await client.query(
					`INSERT INTO app_settings (key, value, updated_by_admin_id, updated_at)
					 VALUES ($1, 'true', $2, now())
					 ON CONFLICT (key) DO UPDATE
					 SET value = 'true', updated_by_admin_id = EXCLUDED.updated_by_admin_id, updated_at = now()`,
					[TEST_MODE_KEY, adminId]
				);
			} else {
				await client.query('DELETE FROM app_settings WHERE key = $1', [TEST_MODE_KEY]);
			}
			await client.query(
				`INSERT INTO admin_audit_log (admin_id, action, target_type, details)
				 VALUES ($1, 'set_test_mode', 'app_settings', $2)`,
				[adminId, JSON.stringify({ on })]
			);
			await client.query('COMMIT');
		} catch (saveError) {
			await client.query('ROLLBACK').catch(() => {});
			logger.error({ adminId, error: String(saveError) }, 'test mode switch failed');
			return fail(500, { message: 'Could not change test mode. Nothing was changed.' });
		} finally {
			client.release();
		}
		logger.warn({ adminId, on }, 'test mode switched');
		return {
			success: true,
			message: on
				? 'Test mode is on. The fraud check is off and alert emails are not sent.'
				: 'Test mode is off. The fraud check and alert emails are back on for the next photo.'
		};
	},
	reset: async ({ locals }) => {
		await pool.query(`DELETE FROM app_settings WHERE key = ANY($1::text[])`, [
			[...Object.keys(ATTENDANCE_SETTING_DEFAULTS), TEST_MODE_KEY]
		]);
		await pool.query(
			`INSERT INTO admin_audit_log (admin_id, action, target_type, details)
			 VALUES ($1, 'reset_settings', 'app_settings', '{}'::jsonb)`,
			[locals.user!.id]
		);
		return {
			success: true,
			message: 'Settings reset to the production defaults. Test mode is off.'
		};
	}
};

// Saves the CC list and records the change in the settings history.
async function saveDigestCc(adminId: string, before: string[], after: string[], done: string) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(
			`INSERT INTO app_settings (key, value, updated_by_admin_id, updated_at)
			 VALUES ($1, $2, $3, now())
			 ON CONFLICT (key) DO UPDATE
			 SET value = EXCLUDED.value, updated_by_admin_id = EXCLUDED.updated_by_admin_id,
			     updated_at = now()`,
			[DIGEST_CC_KEY, after.join(', '), adminId]
		);
		await client.query(
			`INSERT INTO admin_audit_log (admin_id, action, target_type, details)
			 VALUES ($1, 'update_digest_cc', 'app_settings', $2)`,
			[adminId, JSON.stringify({ before, after })]
		);
		await client.query('COMMIT');
	} catch (saveError) {
		await client.query('ROLLBACK').catch(() => {});
		logger.error({ adminId, error: String(saveError) }, 'digest cc save failed');
		return fail(500, { formKind: 'digest-cc', message: 'Could not save. Nothing was changed.' });
	} finally {
		client.release();
	}
	return { formKind: 'digest-cc', success: true, message: done };
}
