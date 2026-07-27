import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { queryOne } from './db';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export type Role = 'admin' | 'vendor' | 'pump';

export interface AuthToken {
	role: Role;
	id: string;
	email: string;
}

export function signToken(payload: AuthToken): string {
	return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): AuthToken | null {
	try {
		return jwt.verify(token, JWT_SECRET) as AuthToken;
	} catch {
		return null;
	}
}

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
} | null> {
	const admin = await queryOne<any>('SELECT id, email, password_hash FROM admins WHERE email = $1', [email]);
	if (admin) return { role: 'admin', ...admin };

	const vendor = await queryOne<any>('SELECT id, email, password_hash FROM vendors WHERE email = $1', [email]);
	if (vendor) return { role: 'vendor', ...vendor };

	const pump = await queryOne<any>(
		'SELECT id, login_email AS email, password_hash FROM pumps WHERE login_email = $1',
		[email]
	);
	if (pump) return { role: 'pump', ...pump };

	return null;
}
