// Correcting a worker's name after the operator wrote it: the vendor (own pumps) and the admin.
// The same rules as naming on the pump: 2 to 60 letters, one name per worker at a pump.
import { pool } from './db';
import { cleanPersonName } from '$lib/personLabel';

type Actor = { role: 'vendor' | 'admin'; id: string };

export async function renamePerson(actor: Actor, personId: string, rawName: unknown) {
	if (!/^[0-9a-f-]{36}$/i.test(personId)) return { status: 404, error: 'Worker not found' };
	const name = cleanPersonName(rawName);
	if (!name) {
		return { status: 400, error: "Write a name of 2 to 60 letters (digits, space, . ' - allowed)." };
	}
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const { rows } = await client.query(
			`SELECT p.id, p.pump_id, p.name FROM persons p JOIN pumps pu ON pu.id = p.pump_id
			 WHERE p.id = $1 AND p.status IN ('active', 'pending_review')
			   AND ($2 = 'admin' OR pu.vendor_id = $3::uuid)
			 FOR UPDATE OF p`,
			[personId, actor.role, actor.id]
		);
		const person = rows[0];
		if (!person) {
			await client.query('ROLLBACK');
			return { status: 404, error: 'Worker not found' };
		}
		const taken = await client.query(
			`SELECT 1 FROM persons WHERE pump_id = $1 AND id <> $2 AND lower(name) = lower($3)
			 AND status IN ('active', 'pending_review')`,
			[person.pump_id, personId, name]
		);
		if (taken.rowCount) {
			await client.query('ROLLBACK');
			return {
				status: 409,
				error: `"${name}" is already the name of another worker at this pump. If it is the same person, ask the admin to merge them.`
			};
		}
		await client.query(
			`UPDATE persons SET name = $2, named_by = $3, named_at = now() WHERE id = $1`,
			[personId, name, actor.role]
		);
		if (actor.role === 'admin') {
			await client.query(
				`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
				 VALUES ($1, 'rename_person', 'person', $2, $3)`,
				[actor.id, personId, JSON.stringify({ from: person.name, to: name })]
			);
		}
		await client.query('COMMIT');
		return { status: 200, name };
	} catch (err: any) {
		await client.query('ROLLBACK').catch(() => {});
		if (err?.code === '23505') {
			return { status: 409, error: 'That name is already the name of another worker at this pump.' };
		}
		throw err;
	} finally {
		client.release();
	}
}
