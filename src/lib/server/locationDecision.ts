// Approving or rejecting a shift start held by the location check, from the app
// (/plant-manager/approvals/[id]) or from the email's signed link (/location/[token], made by
// worker/locationHold.js). One rule for both: only a start still waiting can be decided, so two
// managers of the same plant cannot both decide it, and a rejection needs a reason.
import { pool } from '$lib/server/db';
import { logger } from '$lib/server/log';
import { getJwtSecret } from '$lib/server/auth';
import {
	holdProblem,
	holdWaited,
	loadHoldFacts,
	locationDeciders,
	readLocationToken
} from '../../../worker/locationHold.js';

export type LocationDecision = 'approved' | 'rejected';

export async function decideLocation(
	sessionId: string,
	managerId: string,
	decision: LocationDecision,
	noteInput: unknown,
	via: 'app' | 'email'
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
	const note = String(noteInput ?? '')
		.trim()
		.slice(0, 500);
	if (decision === 'rejected' && !note) {
		return {
			ok: false,
			status: 400,
			error: 'Write why you are rejecting it, so the operator and admin know.'
		};
	}
	const result = await pool.query(
		`UPDATE attendance_sessions
		 SET location_status = $2, location_decided_by = $3, location_decided_at = now(),
		     location_note = NULLIF($4, ''), location_asked_at = COALESCE(location_asked_at, now())
		 WHERE id = $1 AND location_status = 'pending'`,
		[sessionId, decision, managerId, note]
	);
	if (!result.rowCount) {
		return {
			ok: false,
			status: 409,
			error: 'This was already decided. Reload to see the decision.'
		};
	}
	logger.info({ sessionId, managerId, decision, via }, 'location approval decided');
	return { ok: true };
}

// The email link: who it was sent to, whether they may still decide (still the plant's manager or
// the Area's monitor), and the held start in words.
export async function readLocationLink(token: string) {
	const parsed = readLocationToken(getJwtSecret(), token);
	if (!parsed) return null;
	const facts = await loadHoldFacts(pool, parsed.sessionId);
	if (!facts) return null;
	const deciders = await locationDeciders(pool, parsed.sessionId);
	const { rows } = await pool.query('SELECT name FROM plant_managers WHERE id = $1', [
		parsed.managerId
	]);
	return {
		sessionId: parsed.sessionId,
		managerId: parsed.managerId,
		deciderName: (rows[0]?.name as string | undefined) ?? 'you',
		allowed: deciders.some((d) => d.id === parsed.managerId),
		facts,
		problem: holdProblem(facts.location_issue, facts.location_distance_m),
		waited: holdWaited(facts.location_issue, facts.waited_minutes)
	};
}
