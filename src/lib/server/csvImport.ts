// Shared CSV import logic — used by both the seed script and the admin
// CSV bulk-import endpoint, so the import path is exercised from day one.
// See plans/MasterPlan.md §8/§8a/§8b.
import { parse } from 'csv-parse/sync';
import { query, queryOne } from './db';
import { hashPassword } from './auth';

// Vendors that get one login PER AREA instead of a single national account (§8b).
const AREA_SPLIT_VENDORS = ['RDC Concrete (India) Ltd'];

export function normalizeName(name: string): string {
	return name
		.trim()
		.replace(/\s+/g, ' ')
		.replace(/\s*-\s*/g, '-');
}

export function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface ImportSummary {
	rows_total: number;
	rows_created: number;
	rows_skipped: number;
	areas_created: number;
	plants_created: number;
	vendors_created: number;
	pumps_created: number;
	pumps_updated: number;
	errors: { row: number; message: string }[];
}

export async function importCsv(csvText: string): Promise<ImportSummary> {
	const records: Record<string, string>[] = parse(csvText, {
		columns: true,
		skip_empty_lines: true,
		trim: true
	});

	const summary: ImportSummary = {
		rows_total: records.length,
		rows_created: 0,
		rows_skipped: 0,
		areas_created: 0,
		plants_created: 0,
		vendors_created: 0,
		pumps_created: 0,
		pumps_updated: 0,
		errors: []
	};

	for (let i = 0; i < records.length; i++) {
		const row = records[i];
		try {
			const areaName = normalizeName(row['Area Name'] || '');
			const plantName = normalizeName(row['Plant Name'] || '');
			const pumpCode = (row['PUMP Name'] || '').trim();
			const vendorName = normalizeName(row['Vendor Name'] || '');

			if (!areaName || !plantName || !pumpCode || !vendorName) {
				summary.rows_skipped++;
				summary.errors.push({ row: i + 1, message: 'missing required field' });
				continue;
			}

			// find-or-create Area
			let area = await queryOne<any>('SELECT id FROM areas WHERE name = $1', [areaName]);
			if (!area) {
				area = await queryOne<any>('INSERT INTO areas (name) VALUES ($1) RETURNING id', [areaName]);
				summary.areas_created++;
			}

			// find-or-create Plant (scoped to area)
			let plant = await queryOne<any>('SELECT id FROM plants WHERE area_id = $1 AND name = $2', [
				area.id,
				plantName
			]);
			if (!plant) {
				plant = await queryOne<any>('INSERT INTO plants (area_id, name) VALUES ($1, $2) RETURNING id', [
					area.id,
					plantName
				]);
				summary.plants_created++;
			}

			// find-or-create Vendor — Area-split vendors get one account PER area (§8b).
			const isAreaSplit = AREA_SPLIT_VENDORS.includes(vendorName);
			let vendor;
			if (isAreaSplit) {
				vendor = await queryOne<any>('SELECT id FROM vendors WHERE name = $1 AND area_id = $2', [
					vendorName,
					area.id
				]);
				if (!vendor) {
					const email = `${slugify(vendorName)}-${slugify(areaName)}@vendors.local`;
					const passwordHash = await hashPassword('Test1234!');
					vendor = await queryOne<any>(
						`INSERT INTO vendors (name, email, password_hash, area_id, group_name)
						 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
						[vendorName, email, passwordHash, area.id, vendorName]
					);
					summary.vendors_created++;
				}
			} else {
				vendor = await queryOne<any>('SELECT id FROM vendors WHERE name = $1 AND area_id IS NULL', [vendorName]);
				if (!vendor) {
					const email = `${slugify(vendorName)}@vendors.local`;
					const passwordHash = await hashPassword('Test1234!');
					vendor = await queryOne<any>(
						`INSERT INTO vendors (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
						[vendorName, email, passwordHash]
					);
					summary.vendors_created++;
				}
			}

			// UPSERT Pump on pump_code — vendor identity ONLY from the CSV column (never inferred).
			const existingPump = await queryOne<any>('SELECT id FROM pumps WHERE pump_code = $1', [pumpCode]);
			if (existingPump) {
				await query('UPDATE pumps SET plant_id = $1, vendor_id = $2 WHERE id = $3', [
					plant.id,
					vendor.id,
					existingPump.id
				]);
				summary.pumps_updated++;
			} else {
				const loginEmail = `${slugify(pumpCode)}@pumps.local`;
				const passwordHash = await hashPassword('Test1234!');
				await query(
					`INSERT INTO pumps (plant_id, vendor_id, pump_code, login_email, password_hash)
					 VALUES ($1, $2, $3, $4, $5)`,
					[plant.id, vendor.id, pumpCode, loginEmail, passwordHash]
				);
				summary.pumps_created++;
			}

			summary.rows_created++;
		} catch (err: any) {
			summary.rows_skipped++;
			summary.errors.push({ row: i + 1, message: String(err?.message || err) });
		}
	}

	return summary;
}
