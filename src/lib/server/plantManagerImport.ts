// Imports the "Plant Code / Plant Name / Plant Manager Name / Email ID" reference list and
// attaches it to existing plants rows for email notifications. Plant names in this source list
// are not scoped to an Area (unlike Pump Vendor.csv), so matching is done on the plant name alone,
// normalized to ignore case/punctuation/spacing drift between the two sources. Only an unambiguous
// exact match is applied automatically — anything else is reported back for manual resolution
// rather than guessed, since a wrong manager email is worse than a missing one.
import { parse } from 'csv-parse/sync';
import { query } from './db';

export function normalizePlantName(value: string): string {
	return value
		.toLowerCase()
		.replace(/\./g, '')
		.replace(/[^a-z0-9]+/g, '');
}

export interface PlantManagerImportSummary {
	rows_total: number;
	rows_matched: number;
	rows_unmatched: number;
	rows_ambiguous: number;
	unmatched: { row: number; plant_code: string; plant_name: string }[];
	ambiguous: { row: number; plant_code: string; plant_name: string; candidate_count: number }[];
}

export async function importPlantManagers(csvText: string): Promise<PlantManagerImportSummary> {
	const records: Record<string, string>[] = parse(csvText, {
		columns: true,
		skip_empty_lines: true,
		trim: true
	});

	const plants = await query<any>(`SELECT id, name FROM plants`);
	const byNormalizedName = new Map<string, any[]>();
	for (const plant of plants) {
		const key = normalizePlantName(plant.name);
		const bucket = byNormalizedName.get(key) ?? [];
		bucket.push(plant);
		byNormalizedName.set(key, bucket);
	}

	const summary: PlantManagerImportSummary = {
		rows_total: records.length,
		rows_matched: 0,
		rows_unmatched: 0,
		rows_ambiguous: 0,
		unmatched: [],
		ambiguous: []
	};

	for (let i = 0; i < records.length; i++) {
		const row = records[i];
		const plantCode = (row['Plant Code'] || '').trim();
		const plantName = (row['Plant Name'] || '').trim();
		const managerName = (row['Plant Manager Name'] || '').trim();
		const managerEmail = (row['Email ID'] || '').trim();
		if (!plantName) continue;

		const candidates = byNormalizedName.get(normalizePlantName(plantName)) ?? [];
		if (candidates.length === 0) {
			summary.rows_unmatched++;
			summary.unmatched.push({ row: i + 1, plant_code: plantCode, plant_name: plantName });
			continue;
		}
		if (candidates.length > 1) {
			summary.rows_ambiguous++;
			summary.ambiguous.push({
				row: i + 1,
				plant_code: plantCode,
				plant_name: plantName,
				candidate_count: candidates.length
			});
			continue;
		}

		await query(
			`UPDATE plants SET external_code = $1, manager_name = $2, manager_email = $3 WHERE id = $4`,
			[plantCode || null, managerName || null, managerEmail || null, candidates[0].id]
		);
		summary.rows_matched++;
	}

	return summary;
}
