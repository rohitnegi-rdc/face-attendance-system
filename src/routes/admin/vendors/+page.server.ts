import type { Actions, PageServerLoad } from './$types';
import { query, queryOne } from '$lib/server/db';
import { fail } from '@sveltejs/kit';
import { hashPassword } from '$lib/server/auth';
import { slugify, slugifyLogin } from '$lib/server/csvImport';
import { randomBytes } from 'node:crypto';

function temporaryPassword() {
	return randomBytes(15).toString('base64url');
}

export const load: PageServerLoad = async () => {
	const vendors = await query<any>(
		`SELECT v.id, v.name, v.email, v.area_id, a.name AS area_name,
		        COUNT(p.id) AS pump_count
		 FROM vendors v
		 LEFT JOIN areas a ON a.id = v.area_id
		 LEFT JOIN pumps p ON p.vendor_id = v.id
		 GROUP BY v.id, a.name
		 ORDER BY v.name, a.name NULLS FIRST`
	);
	const areas = await query<any>(`SELECT id, name FROM areas ORDER BY name`);
	const plants = await query<any>(
		`SELECT pl.id, pl.name, a.name AS area_name
		 FROM plants pl JOIN areas a ON a.id = pl.area_id
		 ORDER BY a.name, pl.name`
	);
	const pumps = await query<any>(
		`SELECT p.id, p.pump_code, p.login_email, v.name AS vendor_name, pl.name AS plant_name
		 FROM pumps p JOIN vendors v ON v.id = p.vendor_id JOIN plants pl ON pl.id = p.plant_id
		 ORDER BY p.pump_code`
	);

	return { vendors, areas, plants, pumps };
};

export const actions: Actions = {
	createVendor: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') || '').trim();
		const areaId = String(form.get('area_id') || '').trim() || null;

		if (!name) {
			return fail(400, { formKind: 'vendor', message: 'Vendor name is required.' });
		}

		let areaName: string | null = null;
		if (areaId) {
			const area = await queryOne<any>('SELECT name FROM areas WHERE id = $1', [areaId]);
			if (!area) {
				return fail(400, { formKind: 'vendor', message: 'Selected area does not exist.' });
			}
			areaName = area.name;
		}

		const existing = await queryOne<any>(
			areaId
				? 'SELECT id FROM vendors WHERE name = $1 AND area_id = $2'
				: 'SELECT id FROM vendors WHERE name = $1 AND area_id IS NULL',
			areaId ? [name, areaId] : [name]
		);
		if (existing) {
			return fail(400, {
				formKind: 'vendor',
				message: areaId
					? 'This vendor already has a login for this area.'
					: 'A vendor with this name already has a national login.'
			});
		}

		const email = areaName
			? `${slugify(name)}-${slugify(areaName)}@vendors.rdc`
			: `${slugify(name)}@vendors.rdc`;
		const password = temporaryPassword();
		const passwordHash = await hashPassword(password);
		await query(
			`INSERT INTO vendors (name, email, password_hash, area_id, group_name, must_change_password)
			 VALUES ($1, $2, $3, $4, $5, TRUE)`,
			[name, email, passwordHash, areaId, areaId ? name : null]
		);

		return {
			formKind: 'vendor',
			success: true,
			message: 'Vendor created. The user must change this password at first sign-in.',
			credentials: { email, password }
		};
	},

	createPump: async ({ request }) => {
		const form = await request.formData();
		const pumpCode = String(form.get('pump_code') || '').trim();
		const vendorId = String(form.get('vendor_id') || '').trim();
		const plantId = String(form.get('plant_id') || '').trim();

		if (!pumpCode || !vendorId || !plantId) {
			return fail(400, {
				formKind: 'pump',
				message: 'Pump code, vendor, and plant are all required.'
			});
		}

		const existingCode = await queryOne<any>('SELECT id FROM pumps WHERE pump_code = $1', [
			pumpCode
		]);
		if (existingCode) {
			return fail(400, { formKind: 'pump', message: 'A pump with this code already exists.' });
		}

		// Same login-email convention as the CSV importer (csvImport.ts) — kept identical so
		// pumps created here and pumps created by import never diverge in login domain.
		const loginEmail = `${slugifyLogin(pumpCode)}@pumps.local`;
		const existingEmail = await queryOne<any>('SELECT id FROM pumps WHERE login_email = $1', [
			loginEmail
		]);
		if (existingEmail) {
			return fail(400, {
				formKind: 'pump',
				message: 'The generated login email is already in use by another pump.'
			});
		}

		const password = temporaryPassword();
		const passwordHash = await hashPassword(password);
		await query(
			`INSERT INTO pumps (plant_id, vendor_id, pump_code, login_email, password_hash, must_change_password)
			 VALUES ($1, $2, $3, $4, $5, TRUE)`,
			[plantId, vendorId, pumpCode, loginEmail, passwordHash]
		);

		return {
			formKind: 'pump',
			success: true,
			message: 'Pump created. The user must change this password at first sign-in.',
			credentials: { email: loginEmail, password }
		};
	},
	resetVendorPassword: async ({ request }) => {
		const form = await request.formData();
		const id = String(form.get('id') || '').trim();
		const password = temporaryPassword();
		const result = await query(
			'UPDATE vendors SET password_hash = $1, must_change_password = TRUE WHERE id = $2 RETURNING email',
			[await hashPassword(password), id]
		);
		if (!result.length) return fail(404, { formKind: 'reset', message: 'Vendor account not found.' });
		return {
			formKind: 'reset', success: true,
			message: 'Temporary password issued. It is shown once; the user must replace it at sign-in.',
			credentials: { email: result[0].email, password }
		};
	},
	resetPumpPassword: async ({ request }) => {
		const form = await request.formData();
		const id = String(form.get('id') || '').trim();
		const password = temporaryPassword();
		const result = await query(
			'UPDATE pumps SET password_hash = $1, must_change_password = TRUE WHERE id = $2 RETURNING login_email',
			[await hashPassword(password), id]
		);
		if (!result.length) return fail(404, { formKind: 'reset', message: 'Pump account not found.' });
		return {
			formKind: 'reset', success: true,
			message: 'Temporary password issued. It is shown once; the user must replace it at sign-in.',
			credentials: { email: result[0].login_email, password }
		};
	}
};
