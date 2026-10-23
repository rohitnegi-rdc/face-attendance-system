import type { PoolClient } from 'pg';
import { faceMatchThreshold } from './matching';
import {
	findLocalMatch,
	galleryRules,
	keepsInGallery,
	saveFace
} from '../../../worker/faceQueries.js';

// Admin decisions on cross-pump fraud flags (/admin/fraud-flags).
// "Not fraud" gives the worker the attendance the worker withheld: the face stored on the flag is
// matched against the flagged pump's own workers (or becomes a new worker there), then marked
// present for that session. Same matching rules as worker/index.js, local gallery only.

type RollupColumn = 'days_present' | 'days_morning_only' | 'days_evening_only';

export class ResolutionError extends Error {}

function rollupColumn(row: { morning_matched: boolean; evening_matched: boolean } | undefined) {
	if (!row) return null;
	if (row.morning_matched && row.evening_matched) return 'days_present';
	if (row.morning_matched) return 'days_morning_only';
	if (row.evening_matched) return 'days_evening_only';
	return null;
}

async function lockOpenFlag(client: PoolClient, flagId: string) {
	const { rows } = await client.query(
		`SELECT ff.id, ff.reviewed, ff.resolution, ff.face_embedding::text AS face_embedding,
		        ff.face_crop_url, ff.similarity_score,
		        s.id AS session_id, s.pump_id, s.session_date, s.session_type
		 FROM fraud_flags ff
		 JOIN attendance_sessions s ON s.id = ff.session_id
		 WHERE ff.id = $1
		 FOR UPDATE OF ff`,
		[flagId]
	);
	const flag = rows[0];
	if (!flag) throw new ResolutionError('Fraud flag not found.');
	if (flag.reviewed || flag.resolution) throw new ResolutionError('This flag is already resolved.');
	return flag;
}

export async function confirmFraud(client: PoolClient, flagId: string, adminId: string) {
	await lockOpenFlag(client, flagId);
	await client.query(
		`UPDATE fraud_flags
		 SET reviewed = true, resolution = 'confirmed_fraud', resolved_by_admin_id = $2, resolved_at = now()
		 WHERE id = $1`,
		[flagId, adminId]
	);
}

export async function markNotFraud(
	client: PoolClient,
	flagId: string,
	adminId: string,
	// Flags raised before faces were stored on flags have no face to match: the admin picks the
	// worker of the flagged pump instead (/admin/fraud-flags).
	chosenPersonId?: string | null
): Promise<{ personId: string; createdPerson: boolean }> {
	const flag = await lockOpenFlag(client, flagId);
	if (!flag.face_embedding && !chosenPersonId) {
		throw new ResolutionError(
			'This flag has no stored face. Choose the worker at this pump, then press Not fraud.'
		);
	}

	// Best match among the flagged pump's own workers, the same lookup and gallery rules as the
	// worker (worker/faceQueries.js).
	const match = flag.face_embedding
		? await findLocalMatch(client, { vector: flag.face_embedding, pumpId: flag.pump_id })
		: undefined;
	let personId: string;
	let createdPerson = false;
	let inGallery = true;
	if (!flag.face_embedding) {
		const { rowCount } = await client.query(
			`SELECT 1 FROM persons WHERE id = $1 AND pump_id = $2 AND status IN ('active', 'pending_review')`,
			[chosenPersonId, flag.pump_id]
		);
		if (!rowCount) throw new ResolutionError('Choose a worker of the flagged pump.');
		personId = chosenPersonId!;
	} else if (match && match.similarity >= faceMatchThreshold()) {
		personId = match.person_id;
		inGallery = keepsInGallery(match, galleryRules(faceMatchThreshold()));
		await client.query('UPDATE persons SET last_seen_at = now() WHERE id = $1', [personId]);
	} else {
		// The admin has looked at this face, so the new worker starts active, not pending review.
		const { rows } = await client.query<{ id: string }>(
			`INSERT INTO persons (pump_id, status, display_seq)
			 VALUES ($1, 'active', (SELECT COALESCE(MAX(display_seq), 0) + 1 FROM persons WHERE pump_id = $1))
			 RETURNING id`,
			[flag.pump_id]
		);
		personId = rows[0].id;
		createdPerson = true;
	}

	if (flag.face_embedding) {
		await saveFace(client, {
			personId,
			sessionId: flag.session_id,
			vector: flag.face_embedding,
			cropUrl: flag.face_crop_url,
			inGallery,
			isAnchor: createdPerson
		});
	}
	await client.query(
		`INSERT INTO attendance_face_evidence (session_id, person_id, face_crop_url, match_confidence)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (session_id, person_id) DO NOTHING`,
		[flag.session_id, personId, flag.face_crop_url, match?.similarity ?? null]
	);

	const matchedCol = flag.session_type === 'morning' ? 'morning_matched' : 'evening_matched';
	const confidenceCol =
		flag.session_type === 'morning' ? 'morning_confidence' : 'evening_confidence';
	const { rows: before } = await client.query(
		`SELECT morning_matched, evening_matched FROM daily_person_attendance
		 WHERE person_id = $1 AND session_date = $2 FOR UPDATE`,
		[personId, flag.session_date]
	);
	const { rows: after } = await client.query(
		`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, ${matchedCol}, ${confidenceCol})
		 VALUES ($1, $2, $3, true, $4)
		 ON CONFLICT (person_id, session_date)
		 DO UPDATE SET ${matchedCol} = true, ${confidenceCol} = $4, updated_at = now()
		 RETURNING morning_matched, evening_matched`,
		[personId, flag.pump_id, flag.session_date, match?.similarity ?? null]
	);

	// The day may already be counted in the yearly roll-up; move this worker to the right column.
	const { rowCount: finalized } = await client.query(
		'SELECT 1 FROM attendance_rollup_finalizations WHERE pump_id = $1 AND session_date = $2',
		[flag.pump_id, flag.session_date]
	);
	const oldColumn = rollupColumn(before[0]);
	const newColumn = rollupColumn(after[0]) as RollupColumn;
	if (finalized && oldColumn !== newColumn) {
		const { rows: yearRows } = await client.query<{ year: number }>(
			'SELECT EXTRACT(YEAR FROM $1::date)::int AS year',
			[flag.session_date]
		);
		const year = yearRows[0].year;
		if (oldColumn) {
			await client.query(
				`UPDATE person_attendance_yearly SET ${oldColumn} = GREATEST(${oldColumn} - 1, 0), last_updated = now()
				 WHERE person_id = $1 AND year = $2`,
				[personId, year]
			);
		}
		await client.query(
			`INSERT INTO person_attendance_yearly (person_id, year, ${newColumn}) VALUES ($1, $2, 1)
			 ON CONFLICT (person_id, year)
			 DO UPDATE SET ${newColumn} = person_attendance_yearly.${newColumn} + 1, last_updated = now()`,
			[personId, year]
		);
	}

	await client.query(
		`UPDATE fraud_flags
		 SET reviewed = true, resolution = 'not_fraud', resolved_by_admin_id = $2,
		     resolved_at = now(), resolved_person_id = $3
		 WHERE id = $1`,
		[flagId, adminId, personId]
	);
	return { personId, createdPerson };
}
