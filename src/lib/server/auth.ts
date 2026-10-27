import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { queryOne } from './db';

function getJwtSecret(): string {
	const secret = process.env.JWT_SECRET?.trim();
	if (!secret || secret.length < 32 || secret === 'dev-secret-change-me') {
		throw new Error('JWT_SECRET must be configured with at least 32 characters');
	}
	return secret;
}

export type Role = 'admin' | 'vendor' | 'plant-manager' | 'pump';

export interface AuthToken {
	role: Role;
	id: string;
	email: string;
	mustChangePassword?: boolean;
}

export function signToken(
	payload: AuthToken,
	expiresIn: jwt.SignOptions['expiresIn'] = '7d'
): string {
	return jwt.sign(payload, getJwtSecret(), { expiresIn });
}

export function verifyToken(token: string): AuthToken | null {
	try {
		return jwt.verify(token, getJwtSecret()) as AuthToken;
	} catch {
		return null;
	}
}

// Pump and vendor logins start with this password (CSV import) and go back to it when the admin
// or a plant manager resets them; the change is forced at the next sign-in.
export const DEFAULT_PASSWORD = 'Test1234!';

export async function hashPassword(plain: string): Promise<string> {
	return bcrypt.hash(plain, 10);
}

export async function checkPassword(plain: string, hash: string): Promise<boolean> {
	return bcrypt.compare(plain, hash);
}

// Unified login: detect role by matching email against admins, vendors, or pumps.
export async function findAccountByEmail(email: string): Promise<{
	role: Role;
	id: string;
	email: string;
	password_hash: string;
	must_change_password: boolean;
	status?: string;
} | null> {
	const admin = await queryOne<any>(
		'SELECT id, email, password_hash, must_change_password FROM admins WHERE lower(email) = lower($1)',
		[email]
	);
	if (admin) return { role: 'admin', ...admin };

	const vendor = await queryOne<any>(
		'SELECT id, email, password_hash, must_change_password FROM vendors WHERE lower(email) = lower($1)',
		[email]
	);
	if (vendor) return { role: 'vendor', ...vendor };

	const plantManager = await queryOne<any>(
		`SELECT id, email, password_hash, must_change_password FROM plant_managers WHERE lower(email) = lower($1)`,
		[email]
	);
	if (plantManager) return { role: 'plant-manager', ...plantManager };

	// Pumps are never asked to update their password (removed 2026-10-27): operators keep the
	// password they were given, including the default after a reset.
	const pump = await queryOne<any>(
		'SELECT id, login_email AS email, password_hash, status, FALSE AS must_change_password FROM pumps WHERE lower(login_email) = lower($1)',
		[email]
	);
	if (pump) return { role: 'pump', ...pump };

	return null;
}
