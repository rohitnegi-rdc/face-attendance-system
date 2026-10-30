// Correcting a worker's name after the operator wrote it: the vendor (own pumps), the plant manager
// (pumps of their plants) and the admin.
// The same rules as naming on the pump: 2 to 60 letters, one name per worker at a pump.
import { pool } from './db';
import { cleanPersonName } from '$lib/personLabel';

export type RenameActor = { role: 'vendor' | 'plant-manager' | 'admin'; id: string };

export async function renamePerson(actor: RenameActor, personId: string, rawName: unknown) {
	if (!/^[0-9a-f-]{36}$/i.test(personId)) return { status: 404, error: 'Worker not found' };
	const name = cleanPersonName(rawName);
	if (!name) {
		return {
			status: 400,
			error: "Write a name of 2 to 60 letters (digits, space, . ' - allowed)."
		};
	}
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const { rows } = await client.query(
			`SELECT p.id, p.pump_id, p.name FROM persons p JOIN pumps pu ON pu.id = p.pump_id
			 WHERE p.id = $1 AND p.status IN ('active', 'pending_review')
			   AND ($2 = 'admin'
			        OR ($2 = 'vendor' AND pu.vendor_id = $3::uuid)
			        OR ($2 = 'plant-manager' AND EXISTS (
			              SELECT 1 FROM manager_plants pma
			              WHERE pma.plant_id = pu.plant_id AND pma.manager_id = $3::uuid)))
			 FOR UPDATE OF p`,
			[personId, actor.role, actor.id]
		);
		const person = rows[0];
		if (!person) {
			await client.query('ROLLBACK');
			return { status: 404, error: 'Worker not found' };
		}
		await client.query(
			`UPDATE persons SET name = $2, named_by = $3, named_at = now() WHERE id = $1`,
			[personId, name, actor.role]
		);
		// A plant manager's rename is logged with no admin and the manager in `by`.
		if (actor.role !== 'vendor') {
			await client.query(
				`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
				 VALUES ($1, 'rename_person', 'person', $2, $3)`,
				[
					actor.role === 'admin' ? actor.id : null,
					personId,
					JSON.stringify({
						from: person.name,
						to: name,
						...(actor.role === 'admin' ? {} : { by: actor })
					})
				]
			);
		}
		await client.query('COMMIT');
		return { status: 200, name };
	} catch (err: any) {
		await client.query('ROLLBACK').catch(() => {});
		throw err;
	} finally {
		client.release();
	}
}
