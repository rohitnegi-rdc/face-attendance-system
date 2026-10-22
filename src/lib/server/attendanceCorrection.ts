// Manual attendance correction for one worker on one day, by an admin (any pump) or a plant
// manager (pumps of their plants). Typical case: the pump missed the shift start, so the end photo
// became the start and the day shows "start only"; the correction marks the worker present.
// Every change is kept in attendance_corrections with the reason and who made it.
import { pool } from './db';
import { isDateKey } from '$lib/date';
import { shiftStillOpen } from './shiftSessions';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CorrectionActor = { role: 'admin' | 'plant-manager'; id: string };

// SQL condition limiting pumps (alias pu) to what the actor may correct; $1 is the actor id.
export function correctablePumps(role: CorrectionActor['role']) {
	return role === 'admin'
		? '$1::uuid IS NOT NULL'
		: 'pu.plant_id IN (SELECT plant_id FROM plant_manager_assignments WHERE manager_id = $1)';
}

export async function saveCorrection(actor: CorrectionActor, form: FormData) {
	const personId = String(form.get('person_id') || '');
	const pumpId = String(form.get('pump_id') || '');
	const day = String(form.get('day') || '');
	const reason = String(form.get('reason') || '').trim();
	const morningMatched = form.get('morning_present') === 'on';
	const eveningMatched = form.get('evening_present') === 'on';
	if (!UUID_PATTERN.test(personId) || !UUID_PATTERN.test(pumpId) || !isDateKey(day)) {
		return { status: 400, error: 'Invalid attendance correction request', personId };
	}
	if (reason.length < 5 || reason.length > 500) {
		return { status: 400, error: 'Enter a correction reason between 5 and 500 characters', personId };
	}

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const person = await client.query(
			`SELECT p.id FROM persons p JOIN pumps pu ON pu.id = p.pump_id
			 WHERE p.id = $2 AND p.pump_id = $3 AND p.status = 'active' AND ${correctablePumps(actor.role)}
			 FOR UPDATE OF p`,
			[actor.id, personId, pumpId]
		);
		if (!person.rowCount) {
			await client.query('ROLLBACK');
			return { status: 404, error: 'Worker not found for this pump', personId };
		}
		// The pump took at least one photo that day. Both halves can then be marked: a missed
		// shift start leaves only one photo (recorded as the start), and that is what this fixes.
		const sessions = await client.query(
			`SELECT 1 FROM attendance_sessions
			 WHERE pump_id = $1 AND session_date = $2 AND status IN ('review', 'completed')`,
			[pumpId, day]
		);
		if (!sessions.rowCount) {
			await client.query('ROLLBACK');
			return { status: 409, error: 'The pump sent no photo on this date', personId };
		}
		const existing = await client.query(
			`SELECT morning_matched, evening_matched FROM daily_person_attendance
			 WHERE person_id = $1 AND session_date = $2 FOR UPDATE`,
			[personId, day]
		);
		const previousMorning = existing.rows[0]?.morning_matched ?? false;
		const previousEvening = existing.rows[0]?.evening_matched ?? false;

		await client.query(
			`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched, evening_matched, updated_at)
			 VALUES ($1, $2, $3, $4, $5, now())
			 ON CONFLICT (person_id, session_date) DO UPDATE SET morning_matched = EXCLUDED.morning_matched,
			 evening_matched = EXCLUDED.evening_matched, updated_at = now()`,
			[personId, pumpId, day, morningMatched, eveningMatched]
		);
		await client.query(
			`INSERT INTO attendance_corrections
			 (person_id, pump_id, session_date, previous_morning_matched, previous_evening_matched,
			  corrected_morning_matched, corrected_evening_matched, reason,
			  corrected_by_admin_id, corrected_by_manager_id)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			[
				personId,
				pumpId,
				day,
				previousMorning,
				previousEvening,
				morningMatched,
				eveningMatched,
				reason,
				actor.role === 'admin' ? actor.id : null,
				actor.role === 'plant-manager' ? actor.id : null
			]
		);
		await client.query(
			`INSERT INTO person_attendance_yearly
			 (person_id, year, days_present, days_morning_only, days_evening_only, last_updated)
			 SELECT $1, EXTRACT(YEAR FROM $2::date)::int,
			 COUNT(*) FILTER (WHERE morning_matched AND evening_matched),
			 COUNT(*) FILTER (WHERE morning_matched AND NOT evening_matched
			   AND NOT ${shiftStillOpen('daily_person_attendance')}),
			 COUNT(*) FILTER (WHERE NOT morning_matched AND evening_matched), now()
			 FROM daily_person_attendance WHERE person_id = $1
			 AND EXTRACT(YEAR FROM session_date) = EXTRACT(YEAR FROM $2::date)
			 ON CONFLICT (person_id, year) DO UPDATE SET days_present = EXCLUDED.days_present,
			 days_morning_only = EXCLUDED.days_morning_only, days_evening_only = EXCLUDED.days_evening_only,
			 last_updated = now()`,
			[personId, day]
		);
		await client.query('COMMIT');
		return { status: 200, personId, message: 'Attendance correction saved' };
	} catch (err) {
		await client.query('ROLLBACK').catch(() => {});
		throw err;
	} finally {
		client.release();
	}
}
