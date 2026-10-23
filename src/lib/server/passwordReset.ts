// Forgot password and password resets by someone else.
// - Email link: /forgot-password mails a one-use link (30 minutes) to the account's address;
//   /reset-password sets the new password. The page answers the same whether or not the address
//   has an account, so it cannot be used to find out who has one. Not for pump logins: crews
//   have no official mailbox, so their plant manager resets them.
// - Temporary password: the admin (any account) or a plant manager (pumps of their plants)
//   issues one; the user must replace it at the next sign-in (/change-password).
// Every reset is written to password_reset_log.
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { resolve } from '$app/paths';
import { findAccountByEmail, hashPassword, type Role } from '$lib/server/auth';
import { pool, query } from '$lib/server/db';
import { logger } from '$lib/server/log';
import { escapeHtml, mailEnabled, mailer, mailFrom } from '$lib/server/mail';

export const RESET_LINK_MINUTES = 30;
const MAX_LINKS_PER_HOUR = 3;

export const ACCOUNT_TABLES: Record<Role, { table: string; email: string }> = {
	admin: { table: 'admins', email: 'email' },
	vendor: { table: 'vendors', email: 'email' },
	'plant-manager': { table: 'plant_managers', email: 'email' },
	pump: { table: 'pumps', email: 'login_email' }
};

// The same rule for every way of setting a password.
export function passwordProblem(password: string, confirmation: string) {
	if (password.length < 12 || password.length > 128) {
		return 'Choose a password between 12 and 128 characters.';
	}
	if (password !== confirmation) return 'The passwords do not match.';
	return null;
}

// Logins made up by the system (pump01@pumps.rdc, vendor@vendors.rdc, admin@attendance.rdc)
// end in .rdc, which is not a real email domain: nothing can be delivered there.
export function hasMailbox(email: string) {
	return !email.trim().toLowerCase().endsWith('.rdc');
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export async function requestPasswordReset(
	email: string,
	origin: URL
): Promise<'sent' | 'no_mailbox' | 'pump'> {
	const account = await findAccountByEmail(email.trim());
	// Pump crews have no official mailbox, so a pump login is never reset by email, whatever
	// address it uses: its plant manager issues a temporary password instead.
	if (account?.role === 'pump' || /@pumps\.rdc$/i.test(email.trim())) return 'pump';
	if (!hasMailbox(email)) return 'no_mailbox';
	if (!account) {
		logger.info({ email }, 'password reset asked for an unknown email');
		return 'sent';
	}
	const [{ recent }] = await query<{ recent: number }>(
		`SELECT COUNT(*)::int AS recent FROM password_reset_tokens
		 WHERE role = $1 AND account_id = $2 AND created_at > now() - interval '1 hour'`,
		[account.role, account.id]
	);
	if (recent >= MAX_LINKS_PER_HOUR) {
		logger.warn({ role: account.role, accountId: account.id }, 'password reset link limit reached');
		return 'sent';
	}
	const token = randomBytes(32).toString('base64url');
	await query(
		`INSERT INTO password_reset_tokens (role, account_id, token_hash, expires_at)
		 VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
		[account.role, account.id, sha256(token), RESET_LINK_MINUTES]
	);
	// resolve() is relative on the server; anchor it to the request URL.
	const link = new URL(`${resolve('/reset-password')}?token=${token}`, origin).href;
	await sendResetEmail(account.email, link);
	return 'sent';
}

async function sendResetEmail(to: string, link: string) {
	const subject = 'Reset your Face Attendance password';
	try {
		if (!mailEnabled()) {
			logger.info({ to, subject, link }, 'password reset email NOT sent (mail off)');
			return;
		}
		const client = mailer();
		if (!client) {
			logger.warn({ to }, 'password reset email skipped (no SMTP)');
			return;
		}
		const text = `Someone asked to reset the password for ${to}.\n\nSet a new password: ${link}\n\nThe link works for ${RESET_LINK_MINUTES} minutes and only once. If you did not ask for this, ignore this email; your password stays the same.`;
		const html = `
			<p>Someone asked to reset the password for <strong>${escapeHtml(to)}</strong>.</p>
			<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#0b6e69;color:#fff;border-radius:6px;text-decoration:none">Set a new password</a></p>
			<p>The link works for ${RESET_LINK_MINUTES} minutes and only once.</p>
			<p>If you did not ask for this, ignore this email; your password stays the same.</p>`;
		await client.sendMail({ from: mailFrom(), to, subject, text, html });
		logger.info({ to }, 'password reset email sent');
	} catch (err) {
		logger.error(
			{ to, error: err instanceof Error ? err.message : String(err) },
			'password reset email failed'
		);
	}
}

// The account a reset link belongs to, or null when the link is unknown, used or expired.
export async function findResetToken(token: string) {
	if (!token) return null;
	const [row] = await query<{ role: Role; account_id: string }>(
		`SELECT role, account_id FROM password_reset_tokens
		 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
		[sha256(token)]
	);
	if (!row) return null;
	const { table, email } = ACCOUNT_TABLES[row.role];
	const [account] = await query<{ email: string }>(
		`SELECT ${email} AS email FROM ${table} WHERE id = $1`,
		[row.account_id]
	);
	return account ? { role: row.role, accountId: row.account_id, email: account.email } : null;
}

// Sets the new password and uses up every open link of the account. false when the link is no
// longer valid (used by another tab a moment ago, or expired).
export async function resetPasswordWithToken(token: string, password: string) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const {
			rows: [row]
		} = await client.query(
			`SELECT role, account_id FROM password_reset_tokens
			 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
			[sha256(token)]
		);
		if (!row) {
			await client.query('ROLLBACK');
			return false;
		}
		const updated = await setPassword(client, row.role, row.account_id, password, false);
		if (!updated) {
			await client.query('ROLLBACK');
			return false;
		}
		await client.query(
			`INSERT INTO password_reset_log (role, account_id, method) VALUES ($1, $2, 'email_link')`,
			[row.role, row.account_id]
		);
		await client.query('COMMIT');
		logger.info({ role: row.role, accountId: row.account_id }, 'password reset by email link');
		return true;
	} catch (err) {
		await client.query('ROLLBACK').catch(() => {});
		throw err;
	} finally {
		client.release();
	}
}

// A temporary password for an account, shown once to whoever issued it. null when the account
// does not exist.
export async function issueTemporaryPassword(
	role: Role,
	accountId: string,
	by: { role: Role; id: string }
) {
	const password = randomBytes(12).toString('base64url');
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const email = await setPassword(client, role, accountId, password, true);
		if (!email) {
			await client.query('ROLLBACK');
			return null;
		}
		await client.query(
			`INSERT INTO password_reset_log (role, account_id, method, by_role, by_id)
			 VALUES ($1, $2, 'temporary_password', $3, $4)`,
			[role, accountId, by.role, by.id]
		);
		await client.query('COMMIT');
		logger.info({ role, accountId, by }, 'temporary password issued');
		return { email, password };
	} catch (err) {
		await client.query('ROLLBACK').catch(() => {});
		throw err;
	} finally {
		client.release();
	}
}

// Returns the account's email, or null when it does not exist. Any open reset link stops
// working: the password it was meant to replace is gone.
async function setPassword(
	client: PoolClient,
	role: Role,
	accountId: string,
	password: string,
	mustChange: boolean
): Promise<string | null> {
	const { table, email } = ACCOUNT_TABLES[role];
	const {
		rows: [account]
	} = await client.query(
		`UPDATE ${table} SET password_hash = $1, must_change_password = $2 WHERE id = $3
		 RETURNING ${email} AS email`,
		[await hashPassword(password), mustChange, accountId]
	);
	if (!account) return null;
	await client.query(
		`UPDATE password_reset_tokens SET used_at = now()
		 WHERE role = $1 AND account_id = $2 AND used_at IS NULL`,
		[role, accountId]
	);
	return account.email as string;
}
