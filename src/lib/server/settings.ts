import type { Pool, PoolClient } from 'pg';
import { pool } from './db';

// Attendance timing rules, editable by admin at /admin/settings.
// Precedence: app_settings row > env var > default. worker/index.js reads the pairing window the
// same way (it cannot import this file), so keep the key names and defaults in sync with it.
export const ATTENDANCE_SETTING_DEFAULTS = {
	// Shift end needs this many minutes after the shift start photo (non-negotiable: 9h for
	// production). After it the pump screen also offers "End session" (close without a photo).
	evening_min_gap_minutes: 540,
	// An open shift start is auto-closed as "start only" after this many hours. 24h lets a shift
	// start at any time of day, late evening included; the pump's End session button (and the
	// admin Split fix) covers a missed end photo.
	evening_pairing_window_hours: 24
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

// Test mode: one admin switch at /admin/settings, for testing with the same few people at several
// pumps. While on, the cross-pump fraud check is off and the attendance alert emails (fraud alert,
// location approval) are logged instead of sent; password reset emails still go, a person asks for
// those. Off (no row) is production. Every admin page shows a banner while it is on.
// worker/index.js reads the same key (testModeOn); keep the name in sync.
export const TEST_MODE_KEY = 'test_mode';

export type TestModeState = { on: boolean; since: Date | null; by: string | null };

export async function getTestMode(db: Pool | PoolClient = pool): Promise<TestModeState> {
	const { rows } = await db.query<{ value: string; updated_at: Date; email: string | null }>(
		`SELECT s.value, s.updated_at, ad.email
		 FROM app_settings s LEFT JOIN admins ad ON ad.id = s.updated_by_admin_id
		 WHERE s.key = $1`,
		[TEST_MODE_KEY]
	);
	const row = rows[0];
	return row?.value === 'true'
		? { on: true, since: row.updated_at, by: row.email }
		: { on: false, since: null, by: null };
}

export async function isTestModeOn(db: Pool | PoolClient = pool): Promise<boolean> {
	return (await getTestMode(db)).on;
}

// The 9 am attendance email (worker/attendanceDigest.js): addresses copied on every one, edited at
// /admin/settings, the only source of the CC line (migration 045 fills the first list). No row means
// no one is copied. The worker reads the same key; keep it in sync.
export const DIGEST_CC_KEY = 'digest_cc';
// The first day the 9 am email reports on (migration 045: Sunday 1 Nov 2026, so the first email is
// Monday 2 Nov at 9 am). The worker reads the same key.
export const DIGEST_FIRST_DAY_KEY = 'digest_first_day';
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

// Every address in `text` (commas, spaces or new lines between them), lower case, no repeats, and
// the parts that are not an email address.
export function parseEmailList(text: string): { emails: string[]; invalid: string[] } {
	const parts = text
		.split(/[\s,;]+/)
		.map((part) => part.trim().toLowerCase())
		.filter(Boolean);
	return {
		emails: [...new Set(parts.filter((part) => EMAIL.test(part)))],
		invalid: parts.filter((part) => !EMAIL.test(part))
	};
}

export async function getDigestCc(db: Pool | PoolClient = pool): Promise<string[]> {
	const { rows } = await db.query<{ value: string }>(
		'SELECT value FROM app_settings WHERE key = $1',
		[DIGEST_CC_KEY]
	);
	return rows.length ? parseEmailList(rows[0].value).emails : [];
}

export async function getDigestFirstDay(db: Pool | PoolClient = pool): Promise<string | null> {
	const { rows } = await db.query<{ value: string }>(
		'SELECT value FROM app_settings WHERE key = $1',
		[DIGEST_FIRST_DAY_KEY]
	);
	return rows[0]?.value ?? null;
}
