// Per-session evidence for the session logs (admin pump page, plant manager attendance): the group
// photo, every counted worker (name, face on click), and cross-pump fraud on either side of the
// pair (face shown inline).
// A face flagged as fraud is not counted at its pump (the worker skips it), so it is not in
// attendance_face_evidence; it comes from fraud_flags instead.
import { resolve } from '$app/paths';
import { query } from './db';
import { personShortLabel } from '$lib/personLabel';

export type FraudEvidence = {
	flagId: string;
	cropUrl: string | null;
	// flagged: this session is where the face was refused. matched: this session is where the
	// person was already counted, and the same face later turned up at otherPump.
	side: 'flagged' | 'matched';
	otherPump: string;
	otherPlant: string;
	// The worker the face matched, counted at the matched pump: "Worker 4" or the name, so the
	// tiles of one session can be told apart.
	worker: string;
	similarity: number;
	isOperator: boolean;
	state: 'open' | 'confirmed' | 'cleared';
};

type SessionRow = {
	id: string;
	session_type: 'morning' | 'evening';
	photo_url: string | null;
	group_flagged: boolean;
};

export async function attachSessionEvidence<T extends SessionRow>(sessions: T[]) {
	const sessionIds = sessions.map((session) => session.id);
	const [faces, fraudRows] = sessionIds.length
		? await Promise.all([
				query<any>(
					`SELECT afe.id, afe.session_id, afe.person_id, (afe.face_crop_url IS NOT NULL) AS has_crop,
					        p.display_seq, p.is_operator, p.name,
					        EXISTS (
					          SELECT 1 FROM attendance_review_flags arf
					          WHERE arf.session_id = afe.session_id
					            AND arf.person_id = afe.person_id AND arf.status = 'open'
					        ) AS flagged
					 FROM attendance_face_evidence afe JOIN persons p ON p.id = afe.person_id
					 WHERE afe.session_id = ANY($1)
					 ORDER BY p.is_operator DESC, p.display_seq`,
					[sessionIds]
				),
				query<any>(
					`SELECT ff.id, ff.session_id, ff.matched_session_id, ff.face_crop_url, ff.similarity_score,
					        ff.is_operator, ff.reviewed, ff.resolution,
					        fp.pump_code AS flagged_pump, fpl.name AS flagged_plant,
					        mp.pump_code AS matched_pump, mpl.name AS matched_plant,
					        p.display_seq, p.name AS person_name
					 FROM fraud_flags ff
					 JOIN persons p ON p.id = ff.person_id
					 JOIN attendance_sessions fs ON fs.id = ff.session_id
					 JOIN pumps fp ON fp.id = fs.pump_id JOIN plants fpl ON fpl.id = fp.plant_id
					 JOIN pumps mp ON mp.id = ff.matched_at_pump_id JOIN plants mpl ON mpl.id = mp.plant_id
					 WHERE ff.session_id = ANY($1) OR ff.matched_session_id = ANY($1)
					 ORDER BY ff.created_at`,
					[sessionIds]
				)
			])
		: [[], []];

	const peopleBySession = new Map<string, any[]>();
	for (const face of faces) {
		const people = peopleBySession.get(face.session_id) ?? [];
		people.push({
			personId: face.person_id,
			label: personShortLabel(face.display_seq, face.is_operator, face.name),
			// Loaded only when the face is opened; fraud crops below stay inline.
			cropUrl: face.has_crop ? resolve('/api/attendance/face/[id]', { id: face.id }) : null,
			flagged: face.flagged
		});
		peopleBySession.set(face.session_id, people);
	}

	const fraudBySession = new Map<string, FraudEvidence[]>();
	const addFraud = (sessionId: string, item: FraudEvidence) => {
		fraudBySession.set(sessionId, [...(fraudBySession.get(sessionId) ?? []), item]);
	};
	const visible = new Set(sessionIds);
	for (const row of fraudRows) {
		const common = {
			flagId: row.id,
			cropUrl: row.face_crop_url,
			worker: personShortLabel(row.display_seq, false, row.person_name),
			similarity: Number(row.similarity_score),
			isOperator: Boolean(row.is_operator),
			state: (row.resolution === 'not_fraud'
				? 'cleared'
				: row.reviewed
					? 'confirmed'
					: 'open') as FraudEvidence['state']
		};
		if (visible.has(row.session_id)) {
			addFraud(row.session_id, {
				...common,
				side: 'flagged',
				otherPump: row.matched_pump,
				otherPlant: row.matched_plant
			});
		}
		if (visible.has(row.matched_session_id)) {
			addFraud(row.matched_session_id, {
				...common,
				side: 'matched',
				otherPump: row.flagged_pump,
				otherPlant: row.flagged_plant
			});
		}
	}

	return sessions.map((session) => {
		const fraud = fraudBySession.get(session.id) ?? [];
		return {
			...session,
			// A storage path; the page only gets the guarded photo route below.
			photo_url: undefined,
			// Pumps this session shares a person with, while the case is open or confirmed.
			fraudPumps: [...new Set(fraud.filter((f) => f.state !== 'cleared').map((f) => f.otherPump))],
			evidence: {
				id: session.id,
				sessionType: session.session_type,
				groupPhotoUrl: session.photo_url
					? resolve('/api/attendance/photo/[id]', { id: session.id })
					: null,
				groupFlagged: session.group_flagged,
				people: peopleBySession.get(session.id) ?? [],
				fraud
			}
		};
	});
}
