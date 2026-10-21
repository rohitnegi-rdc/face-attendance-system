import { query, queryOne } from './db';

// Untouched copies of attendance photos that failed or were flagged as fraud
// (db/migrations/025_photo_backups.sql). Kept forever; admin sees all, a plant manager only the
// pumps of their plants.

export interface PhotoBackup {
	id: string;
	session_id: string | null;
	pump_id: string;
	pump_code: string;
	plant_name: string;
	area_name: string;
	session_date: string;
	session_type: string;
	status: 'waiting' | 'failed' | 'fraud';
	reason: string | null;
	error_detail: string | null;
	uploaded_at: string;
}

const LIST_LIMIT = 300;

// A copy still 'waiting' after an hour is stuck (worker down, or its session deleted before
// processing), so it is shown too; a younger one is most likely being processed right now.
export async function listPhotoBackups(managerId: string | null): Promise<PhotoBackup[]> {
	return query<PhotoBackup>(
		`SELECT b.id, b.session_id, b.pump_id, pu.pump_code, pl.name AS plant_name, a.name AS area_name,
		        b.session_date::text AS session_date, b.session_type, b.status, b.reason, b.error_detail,
		        to_char(b.uploaded_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, HH12:MI am') AS uploaded_at
		 FROM attendance_photo_backups b
		 JOIN pumps pu ON pu.id = b.pump_id
		 JOIN plants pl ON pl.id = pu.plant_id
		 JOIN areas a ON a.id = pl.area_id
		 WHERE (b.status <> 'waiting' OR b.uploaded_at < now() - interval '1 hour')
		   AND ($1::uuid IS NULL OR EXISTS (
		         SELECT 1 FROM plant_manager_assignments pma
		         WHERE pma.plant_id = pu.plant_id AND pma.manager_id = $1))
		 ORDER BY b.uploaded_at DESC
		 LIMIT ${LIST_LIMIT}`,
		[managerId]
	);
}

// The file of one copy, if this viewer may see it: admin always, a plant manager for their plants.
export async function photoBackupFile(
	id: string,
	viewer: { role: string; id: string }
): Promise<string | null> {
	if (viewer.role !== 'admin' && viewer.role !== 'plant-manager') return null;
	const row = await queryOne<{ file_path: string }>(
		`SELECT b.file_path FROM attendance_photo_backups b
		 JOIN pumps pu ON pu.id = b.pump_id
		 WHERE b.id = $1
		   AND ($2::uuid IS NULL OR EXISTS (
		         SELECT 1 FROM plant_manager_assignments pma
		         WHERE pma.plant_id = pu.plant_id AND pma.manager_id = $2))`,
		[id, viewer.role === 'admin' ? null : viewer.id]
	);
	return row?.file_path ?? null;
}
