import type { Pool, PoolClient } from 'pg';
import { pool } from './db';

// Attendance timing rules, editable by admin at /admin/settings.
// Precedence: app_settings row > env var > default. worker/index.js reads the pairing window the
// same way (it cannot import this file), so keep the key names and defaults in sync with it.
export const ATTENDANCE_SETTING_DEFAULTS = {
	// Evening needs this many minutes after the morning photo (non-negotiable: 9h for production).
	evening_min_gap_minutes: 540,
	// An open morning stops waiting for its evening after this many hours. 16h covers a normal
	// shift plus night shifts that cross midnight, but stops a missed evening from swallowing the
	// next day's morning photo.
	evening_pairing_window_hours: 16
} as const;

export const ATTENDANCE_SETTING_LIMITS = {
	evening_min_gap_minutes: { min: 1, max: 1440 },
	evening_pairing_window_hours: { min: 1, max: 48 }
} as const;

export type AttendanceSettingKey = keyof typeof ATTENDANCE_SETTING_DEFAULTS;
export type AttendanceSettings = Record<AttendanceSettingKey, number>;

const ENV_NAMES: Record<AttendanceSettingKey, string> = {
	evening_min_gap_minutes: 'EVENING_MIN_GAP_MINUTES',
	evening_pairing_window_hours: 'EVENING_PAIRING_WINDOW_HOURS'
};

export type SettingSource = 'admin' | 'env' | 'default';

function envOrDefault(key: AttendanceSettingKey): { value: number; source: SettingSource } {
	const raw = process.env[ENV_NAMES[key]]?.trim();
	const parsed = raw ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0
		? { value: parsed, source: 'env' }
		: { value: ATTENDANCE_SETTING_DEFAULTS[key], source: 'default' };
}

export async function getAttendanceSettingsWithSource(
	db: Pool | PoolClient = pool
): Promise<Record<AttendanceSettingKey, { value: number; source: SettingSource }>> {
	const keys = Object.keys(ATTENDANCE_SETTING_DEFAULTS) as AttendanceSettingKey[];
	const { rows } = await db.query<{ key: string; value: string }>(
		'SELECT key, value FROM app_settings WHERE key = ANY($1::text[])',
		[keys]
	);
	const stored = new Map(rows.map((row) => [row.key, Number(row.value)]));
	return Object.fromEntries(
		keys.map((key) => {
			const value = stored.get(key);
			return [
				key,
				value !== undefined && Number.isFinite(value) && value > 0
					? { value, source: 'admin' as const }
					: envOrDefault(key)
			];
		})
	) as Record<AttendanceSettingKey, { value: number; source: SettingSource }>;
}

export async function getAttendanceSettings(
	db: Pool | PoolClient = pool
): Promise<AttendanceSettings> {
	const withSource = await getAttendanceSettingsWithSource(db);
	return {
		evening_min_gap_minutes: withSource.evening_min_gap_minutes.value,
		evening_pairing_window_hours: withSource.evening_pairing_window_hours.value
	};
}

// Returns an error message, or null when the pair is valid.
export function validateAttendanceSettings(settings: AttendanceSettings): string | null {
	for (const key of Object.keys(ATTENDANCE_SETTING_LIMITS) as AttendanceSettingKey[]) {
		const { min, max } = ATTENDANCE_SETTING_LIMITS[key];
		const value = settings[key];
		if (!Number.isInteger(value) || value < min || value > max) {
			return `${key.replaceAll('_', ' ')} must be a whole number from ${min} to ${max}.`;
		}
	}
	if (settings.evening_pairing_window_hours * 60 <= settings.evening_min_gap_minutes) {
		return 'The pairing window must be longer than the evening gap, otherwise evening can never be submitted.';
	}
	return null;
}
