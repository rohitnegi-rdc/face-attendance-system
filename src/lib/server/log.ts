// Structured JSON logging (plans/MasterPlan.md §7a). Every service (app, worker, ai-service)
// writes the same line shape to stdout: timestamp (ISO, IST), level, service, message, fields.
// Warnings and errors are also kept in system_logs for the admin Logs page (/admin/logs).
import pino from 'pino';
import { pool } from './db';

const SERVICE = 'app';
const STORED_LEVELS: Record<number, 'warn' | 'error' | 'fatal'> = {
	40: 'warn',
	50: 'error',
	60: 'fatal'
};
// Bigger details (a long stack, a whole request) are cut so one line cannot bloat the table.
const MAX_DETAILS_CHARS = 8000;

// ISO 8601 in Asia/Kolkata, computed in code (never the container's time zone).
export function istTimestamp(date = new Date()) {
	return new Date(date.getTime() + 330 * 60_000).toISOString().replace('Z', '+05:30');
}

function text(value: unknown) {
	return value == null || value === '' ? null : String(value);
}

// Never throws and never logs through the logger: a broken database must not take logging down.
export function storeLog(
	service: string,
	level: 'warn' | 'error' | 'fatal',
	message: string,
	fields: Record<string, unknown> = {}
) {
	if (!process.env.DATABASE_URL) return;
	let details = JSON.stringify(fields);
	if (details.length > MAX_DETAILS_CHARS) {
		details = JSON.stringify({ truncated: details.slice(0, MAX_DETAILS_CHARS) });
	}
	pool
		.query(
			`INSERT INTO system_logs (level, service, message, request_id, session_id, pump_id, details)
			 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
			[
				level,
				service,
				message || '(no message)',
				text(fields.requestId ?? fields.request_id),
				text(fields.sessionId ?? fields.session_id),
				text(fields.pumpId ?? fields.pump_id),
				details
			]
		)
		.catch((err) => {
			process.stderr.write(
				`${JSON.stringify({ timestamp: istTimestamp(), level: 'error', service: SERVICE, message: 'could not store log line', error: String(err?.message || err) })}\n`
			);
		});
}

export const logger = pino({
	base: { service: SERVICE },
	messageKey: 'message',
	timestamp: () => `,"timestamp":"${istTimestamp()}"`,
	formatters: { level: (label) => ({ level: label }) },
	hooks: {
		logMethod(args, method, level) {
			const stored = STORED_LEVELS[level];
			if (stored) {
				const [first, second] = args as unknown[];
				// logger.error(err): an Error has no enumerable fields, keep its message and stack.
				const fields =
					first instanceof Error
						? { error: first.stack ?? first.message }
						: first && typeof first === 'object'
							? (first as Record<string, unknown>)
							: {};
				const message =
					typeof first === 'string'
						? first
						: typeof second === 'string'
							? second
							: first instanceof Error
								? first.message
								: '';
				storeLog(SERVICE, stored, message, fields);
			}
			return method.apply(this, args);
		}
	}
});
