// A pump's direct sign-in link (migration 047). The token is the link's id and a signature of it,
// so the database alone cannot produce a working link and the admin can copy it again later.
// Opening it: src/routes/link/[token]. Managing it: src/routes/admin/pump-links.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getJwtSecret } from '$lib/server/auth';
import { pool, query, queryOne } from '$lib/server/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string) => UUID.test(value);

const signature = (id: string) =>
	createHmac('sha256', getJwtSecret()).update(`pump-link:${id}`).digest('base64url');

export const linkToken = (id: string) => `${id}.${signature(id)}`;

function linkIdFrom(token: string): string | null {
	const [id, given, extra] = token.split('.');
	if (!id || !given || extra !== undefined || !isUuid(id)) return null;
	const expected = Buffer.from(signature(id));
	const actual = Buffer.from(given);
	return expected.length === actual.length && timingSafeEqual(expected, actual) ? id : null;
}

// The pump a working link belongs to; null for a changed, unknown or revoked link.
export async function pumpFromLink(token: string) {
	const id = linkIdFrom(token);
	if (!id) return null;
	return queryOne<{ link_id: string; id: string; email: string; status: string }>(
		`SELECT l.id AS link_id, pu.id, pu.login_email AS email, pu.status
		 FROM pump_login_links l JOIN pumps pu ON pu.id = l.pump_id
		 WHERE l.id = $1 AND l.revoked_at IS NULL`,
		[id]
	);
}

// Still good for a session: not revoked, and the pump's login is not disabled.
export async function isLinkActive(linkId: string) {
	const link = await queryOne(
		`SELECT 1 FROM pump_login_links l JOIN pumps pu ON pu.id = l.pump_id
		 WHERE l.id = $1 AND l.revoked_at IS NULL AND pu.status <> 'disabled'`,
		[linkId]
	);
	return Boolean(link);
}

// Both write the change and its audit row in one statement. A pump that already has a working link
// keeps it (a second tap or a second admin changes nothing).
export async function createPumpLink(pumpId: string, adminId: string) {
	await pool.query(
		`WITH made AS (
		   INSERT INTO pump_login_links (pump_id, created_by)
		   SELECT id, $2::uuid FROM pumps WHERE id = $1
		   ON CONFLICT (pump_id) WHERE revoked_at IS NULL DO NOTHING
		   RETURNING id, pump_id
		 )
		 INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
		 SELECT $2::uuid, 'pump_link_created', 'pump', pump_id::text, jsonb_build_object('link_id', id)
		 FROM made`,
		[pumpId, adminId]
	);
}

export async function revokePumpLink(pumpId: string, adminId: string) {
	await pool.query(
		`WITH gone AS (
		   UPDATE pump_login_links SET revoked_at = now(), revoked_by = $2::uuid
		   WHERE pump_id = $1 AND revoked_at IS NULL
		   RETURNING id, pump_id
		 )
		 INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
		 SELECT $2::uuid, 'pump_link_revoked', 'pump', pump_id::text, jsonb_build_object('link_id', id)
		 FROM gone`,
		[pumpId, adminId]
	);
}

export type PumpLinkRow = {
	id: string;
	pump_code: string;
	status: string;
	vendor_name: string;
	plant_id: string;
	plant_name: string;
	area_id: string;
	area_name: string;
	link_id: string | null;
	link_created_at: Date | null;
};

// Every pump in Area, plant, pump order, with its working link if it has one.
export async function listPumpLinks(q: string, areaId: string) {
	const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	return query<PumpLinkRow>(
		`SELECT pu.id, pu.pump_code, pu.status, v.name AS vendor_name,
		        pl.id AS plant_id, pl.name AS plant_name, a.id AS area_id, a.name AS area_name,
		        l.id AS link_id, l.created_at AS link_created_at
		 FROM pumps pu
		 JOIN plants pl ON pl.id = pu.plant_id
		 JOIN areas a ON a.id = pl.area_id
		 JOIN vendors v ON v.id = pu.vendor_id
		 LEFT JOIN pump_login_links l ON l.pump_id = pu.id AND l.revoked_at IS NULL
		 WHERE ($1 = '' OR pu.pump_code ILIKE $2 OR pl.name ILIKE $2 OR a.name ILIKE $2 OR v.name ILIKE $2)
		   AND ($3 = '' OR a.id::text = $3)
		 ORDER BY a.name, pl.name, pu.pump_code`,
		[q, like, areaId]
	);
}
