import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { pool, query } from '$lib/server/db';
import { logger } from '$lib/server/log';
import {
	ATTENDANCE_SETTING_DEFAULTS,
	ATTENDANCE_SETTING_LIMITS,
	FRAUD_CHECK_DISABLED_KEY,
	getAttendanceSettingsWithSource,
	isFraudCheckDisabled,
	isTestMode,
	validateAttendanceSettings,
	type AttendanceSettings
} from '$lib/server/settings';

export const load: PageServerLoad = async () => {
	const [settings, fraudCheckDisabled, auditLog] = await Promise.all([
		getAttendanceSettingsWithSource(),
		isFraudCheckDisabled(),
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
		testMode: isTestMode(),
		fraudCheckDisabled,
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
	// Test mode only: switch the cross-pump fraud check off or back on.
	fraudCheck: async ({ request, locals }) => {
		if (!isTestMode()) {
			return fail(403, { message: 'The fraud check can only be switched off in test mode.' });
		}
		const enabled = (await request.formData()).get('enabled') === 'true';
		const adminId = locals.user!.id;
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			if (enabled) {
				await client.query('DELETE FROM app_settings WHERE key = $1', [FRAUD_CHECK_DISABLED_KEY]);
			} else {
				await client.query(
					`INSERT INTO app_settings (key, value, updated_by_admin_id, updated_at)
					 VALUES ($1, 'true', $2, now())
					 ON CONFLICT (key) DO UPDATE
					 SET value = 'true', updated_by_admin_id = EXCLUDED.updated_by_admin_id, updated_at = now()`,
					[FRAUD_CHECK_DISABLED_KEY, adminId]
				);
			}
			await client.query(
				`INSERT INTO admin_audit_log (admin_id, action, target_type, details)
				 VALUES ($1, 'set_fraud_check', 'app_settings', $2)`,
				[adminId, JSON.stringify({ enabled })]
			);
			await client.query('COMMIT');
		} catch (saveError) {
			await client.query('ROLLBACK').catch(() => {});
			logger.error({ adminId, error: String(saveError) }, 'fraud check switch failed');
			return fail(500, { message: 'Could not change the fraud check. Nothing was changed.' });
		} finally {
			client.release();
		}
		logger.warn({ adminId, enabled }, 'cross-pump fraud check switched');
		return {
			success: true,
			message: enabled
				? 'Fraud check is on again for the next photo.'
				: 'Fraud check is off. Photos are not checked against other pumps.'
		};
	},
	reset: async ({ locals }) => {
		await pool.query(`DELETE FROM app_settings WHERE key = ANY($1::text[])`, [
			[...Object.keys(ATTENDANCE_SETTING_DEFAULTS), FRAUD_CHECK_DISABLED_KEY]
		]);
		await pool.query(
			`INSERT INTO admin_audit_log (admin_id, action, target_type, details)
			 VALUES ($1, 'reset_settings', 'app_settings', '{}'::jsonb)`,
			[locals.user!.id]
		);
		return { success: true, message: 'Settings reset to the production defaults.' };
	}
};
