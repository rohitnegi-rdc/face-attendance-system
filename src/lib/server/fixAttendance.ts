// Fix attendance for one pump and day, the same page for the admin and the plant manager or
// monitor (src/lib/components/FixAttendance.svelte): "Same people?", the roster ticks, rename, a
// face counted for the wrong worker, a worker counted twice, and a worker the camera missed. A
// plant manager reaches only the pumps of their plants, a monitor those of their Areas
// (manager_plants); every change is logged with who made it.
import { error, fail, redirect, type Actions, type RequestEvent } from '@sveltejs/kit';
import type { PoolClient } from 'pg';
import { pool, query, queryOne } from '$lib/server/db';
import { isDateKey } from '$lib/date';
import { saveCorrection } from '$lib/server/attendanceCorrection';
import { logger } from '$lib/server/log';
import {
	FaceFixError,
	markPresent,
	moveFace,
	recalculateYear,
	type FixActor
} from '$lib/server/faceFixes';
import { formText, runFaceFix } from '$lib/server/faceFixActions';
import { findSamePeople, mergeSamePeople, mergedMessage } from '$lib/server/samePeople';
import { renamePerson } from '$lib/server/personNames';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The admin sees every pump; a plant manager ($2) only the pumps of their plants.
const PUMP_ALLOWED = `($3 = 'admin' OR EXISTS (
	SELECT 1 FROM manager_plants pma WHERE pma.plant_id = pu.plant_id AND pma.manager_id = $2::uuid))`;

async function allowedPump(client: PoolClient, actor: FixActor, pumpId: string) {
	if (!UUID_PATTERN.test(pumpId)) return false;
	const { rowCount } = await client.query(
		`SELECT 1 FROM pumps pu WHERE pu.id = $1 AND ${PUMP_ALLOWED}`,
		[pumpId, actor.id, actor.role]
	);
	return rowCount === 1;
}

export async function loadFixAttendance(actor: FixActor, url: URL, backPath: string) {
	const pumpId = url.searchParams.get('pump') || '';
	const day = url.searchParams.get('day') || '';
	if (!UUID_PATTERN.test(pumpId) || !isDateKey(day)) redirect(303, backPath);

	const pump = await queryOne<any>(
		`SELECT pu.id, pu.pump_code, v.name AS vendor_name, pl.name AS plant_name, a.name AS area_name
		 FROM pumps pu JOIN vendors v ON v.id = pu.vendor_id JOIN plants pl ON pl.id = pu.plant_id
		 JOIN areas a ON a.id = pl.area_id WHERE pu.id = $1 AND ${PUMP_ALLOWED}`,
		[pumpId, actor.id, actor.role]
	);
	if (!pump) error(404, 'Pump not found');

	const [sessions, people, faces, corrections, duplicates] = await Promise.all([
		query<any>(
			`SELECT id, session_type, status, submitted_at, photo_url IS NOT NULL AS has_photo
			 FROM attendance_sessions WHERE pump_id = $1 AND session_date = $2
			 ORDER BY submitted_at`,
			[pumpId, day]
		),
		// Not a full shift first: those are the ones people come here to fix.
		query<any>(
			`SELECT p.id, p.display_seq, p.name, p.is_operator,
			        COALESCE(dpa.morning_matched, false) AS morning_matched,
			        COALESCE(dpa.evening_matched, false) AS evening_matched,
			        EXISTS (SELECT 1 FROM person_face_vectors
			                WHERE person_id = p.id AND source_photo_crop_url IS NOT NULL) AS has_face
			 FROM persons p
			 LEFT JOIN daily_person_attendance dpa ON dpa.person_id = p.id AND dpa.session_date = $2
			 WHERE p.pump_id = $1 AND p.status = 'active'
			 ORDER BY COALESCE(dpa.morning_matched AND dpa.evening_matched, false), p.display_seq`,
			[pumpId, day]
		),
		// Each worker's face in each counted photo of the day, for "Wrong worker?".
		query<any>(
			`SELECT afe.person_id, afe.id AS evidence_id, afe.face_crop_url IS NOT NULL AS has_crop,
			        s.id AS session_id, s.session_type
			 FROM attendance_face_evidence afe JOIN attendance_sessions s ON s.id = afe.session_id
			 WHERE s.pump_id = $1 AND s.session_date = $2 AND s.status IN ('review', 'completed')
			 ORDER BY s.submitted_at`,
			[pumpId, day]
		),
		query<any>(
			`SELECT ac.id, p.display_seq, p.name, ac.reason, ac.corrected_at,
			        ac.corrected_morning_matched, ac.corrected_evening_matched,
			        coalesce(adm.email, pm.name) AS corrected_by
			 FROM attendance_corrections ac JOIN persons p ON p.id = ac.person_id
			 LEFT JOIN admins adm ON adm.id = ac.corrected_by_admin_id
			 LEFT JOIN plant_managers pm ON pm.id = ac.corrected_by_manager_id
			 WHERE ac.pump_id = $1 AND ac.session_date = $2 ORDER BY ac.corrected_at DESC LIMIT 20`,
			[pumpId, day]
		),
		query<any>(
			`SELECT adr.id, adr.kept_person_id, adr.duplicate_person_id, adr.session_type,
			        adr.reason, adr.resolved_at, adr.reversed_at,
			        kept.display_seq AS kept_seq, kept.name AS kept_name,
			        dup.display_seq AS duplicate_seq, dup.name AS duplicate_name,
			        coalesce(adm.email, pm.name) AS resolved_by
			 FROM attendance_duplicate_resolutions adr
			 JOIN persons kept ON kept.id = adr.kept_person_id
			 JOIN persons dup ON dup.id = adr.duplicate_person_id
			 LEFT JOIN admins adm ON adm.id = adr.resolved_by_admin_id
			 LEFT JOIN plant_managers pm ON pm.id = adr.resolved_by_manager_id
			 WHERE adr.pump_id = $1 AND adr.session_date = $2
			 ORDER BY adr.resolved_at DESC LIMIT 20`,
			[pumpId, day]
		)
	]);
	const same = await findSamePeople(pool, pumpId, day);
	const facesOf = (personId: string) =>
		faces
			.filter((face) => face.person_id === personId)
			.map((face) => ({
				sessionId: face.session_id as string,
				sessionType: face.session_type as 'morning' | 'evening',
				evidenceId: face.evidence_id as string,
				hasCrop: Boolean(face.has_crop)
			}));
	return {
		pump,
		day,
		sessions,
		people: people.map((person) => ({ ...person, faces: facesOf(person.id) })),
		corrections,
		duplicates,
		same
	};
}

// Worker `keptId` and worker `duplicateId` are one person counted twice in one photo: the kept
// worker is counted, the duplicate is not. The previous ticks are kept for the undo.
async function markDuplicate(client: PoolClient, actor: FixActor, form: FormData) {
	const keptId = formText(form, 'person_id');
	const duplicateId = formText(form, 'duplicate_person_id');
	const pumpId = formText(form, 'pump_id');
	const day = formText(form, 'day');
	const sessionType = formText(form, 'session_type');
	const reason = formText(form, 'duplicate_reason');
	if (
		![keptId, duplicateId, pumpId].every((value) => UUID_PATTERN.test(value)) ||
		keptId === duplicateId ||
		!isDateKey(day)
	) {
		throw new FaceFixError('Pick the other worker who is the same person.');
	}
	if (!['morning', 'evening'].includes(sessionType))
		throw new FaceFixError('Choose shift start or shift end.');
	if (reason.length < 5 || reason.length > 500)
		throw new FaceFixError('Write how you checked, 5 to 500 letters.');
	if (!(await allowedPump(client, actor, pumpId))) throw new FaceFixError('Pump not found.');

	const pair = await client.query(
		`SELECT a.id FROM persons a JOIN persons b ON b.id = $2
		 WHERE a.id = $1 AND a.pump_id = $3 AND b.pump_id = $3
		 AND a.status = 'active' AND b.status = 'active' FOR UPDATE OF a, b`,
		[keptId, duplicateId, pumpId]
	);
	if (!pair.rowCount) throw new FaceFixError('Both workers must be active at the same pump.');
	const session = await client.query(
		`SELECT id FROM attendance_sessions WHERE pump_id = $1 AND session_date = $2
		 AND session_type = $3 AND status IN ('review', 'completed')`,
		[pumpId, day, sessionType]
	);
	if (!session.rowCount) throw new FaceFixError('There is no counted photo for that shift half.');
	const existing = await client.query(
		`SELECT id FROM attendance_duplicate_resolutions WHERE pump_id = $1 AND session_date = $2
		 AND session_type = $3 AND duplicate_person_id = $4 AND reversed_at IS NULL FOR UPDATE`,
		[pumpId, day, sessionType, duplicateId]
	);
	if (existing.rowCount) throw new FaceFixError('That worker is already marked counted twice.');
	const previous = await client.query(
		`SELECT person_id, morning_matched, evening_matched FROM daily_person_attendance
		 WHERE session_date = $1 AND person_id IN ($2, $3) FOR UPDATE`,
		[day, keptId, duplicateId]
	);
	const previousFor = (personId: string) => {
		const row = previous.rows.find((item) => item.person_id === personId);
		return sessionType === 'morning'
			? (row?.morning_matched ?? false)
			: (row?.evening_matched ?? false);
	};

	await client.query(
		`INSERT INTO daily_person_attendance (person_id, pump_id, session_date, morning_matched, evening_matched, updated_at)
		 VALUES ($1, $2, $3, $4, $5, now())
		 ON CONFLICT (person_id, session_date) DO UPDATE SET
		 morning_matched = CASE WHEN $6 = 'morning' THEN $4 ELSE daily_person_attendance.morning_matched END,
		 evening_matched = CASE WHEN $6 = 'evening' THEN $5 ELSE daily_person_attendance.evening_matched END,
		 updated_at = now()`,
		[keptId, pumpId, day, sessionType === 'morning', sessionType === 'evening', sessionType]
	);
	await client.query(
		`UPDATE daily_person_attendance SET
		 morning_matched = CASE WHEN $3 = 'morning' THEN false ELSE morning_matched END,
		 evening_matched = CASE WHEN $3 = 'evening' THEN false ELSE evening_matched END,
		 updated_at = now() WHERE person_id = $1 AND session_date = $2`,
		[duplicateId, day, sessionType]
	);
	await client.query(
		`INSERT INTO attendance_duplicate_resolutions
		 (kept_person_id, duplicate_person_id, pump_id, session_date, session_type,
		  previous_kept_present, previous_duplicate_present, reason,
		  resolved_by_admin_id, resolved_by_manager_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		[
			keptId,
			duplicateId,
			pumpId,
			day,
			sessionType,
			previousFor(keptId),
			previousFor(duplicateId),
			reason,
			actor.role === 'admin' ? actor.id : null,
			actor.role === 'plant-manager' ? actor.id : null
		]
	);
	await recalculateYear(client, keptId, day);
	await recalculateYear(client, duplicateId, day);
	return 'Saved. The extra count is removed; this worker stays present.';
}

async function undoDuplicate(client: PoolClient, actor: FixActor, form: FormData) {
	const resolutionId = formText(form, 'resolution_id');
	if (!UUID_PATTERN.test(resolutionId)) throw new FaceFixError('This decision was not found.');
	const { rows } = await client.query(
		`SELECT * FROM attendance_duplicate_resolutions WHERE id = $1 AND reversed_at IS NULL FOR UPDATE`,
		[resolutionId]
	);
	const resolution = rows[0];
	if (!resolution) throw new FaceFixError('This decision was already undone.');
	if (!(await allowedPump(client, actor, resolution.pump_id)))
		throw new FaceFixError('This decision was not found.');
	for (const [personId, present] of [
		[resolution.kept_person_id, resolution.previous_kept_present],
		[resolution.duplicate_person_id, resolution.previous_duplicate_present]
	]) {
		await client.query(
			`UPDATE daily_person_attendance SET
			 morning_matched = CASE WHEN $3 = 'morning' THEN COALESCE($4, false) ELSE morning_matched END,
			 evening_matched = CASE WHEN $3 = 'evening' THEN COALESCE($4, false) ELSE evening_matched END,
			 updated_at = now() WHERE person_id = $1 AND session_date = $2`,
			[personId, resolution.session_date, resolution.session_type, present]
		);
		await recalculateYear(client, personId, resolution.session_date);
	}
	await client.query(
		`UPDATE attendance_duplicate_resolutions
		 SET reversed_at = now(), reversed_by_admin_id = $2, reversed_by_manager_id = $3 WHERE id = $1`,
		[
			resolutionId,
			actor.role === 'admin' ? actor.id : null,
			actor.role === 'plant-manager' ? actor.id : null
		]
	);
	return 'Undone. Both workers have their earlier attendance back.';
}

// The form actions of both Fix attendance pages. A result about one worker names them
// (personId), so the page shows the message on that worker's row.
export function fixAttendanceActions(role: FixActor['role']): Actions {
	const actorOf = (event: RequestEvent): FixActor | null =>
		event.locals.user?.role === role ? { role, id: event.locals.user.id } : null;
	const run = async (
		event: RequestEvent,
		name: string,
		// A fix may name the worker its message belongs on (a moved face: the worker who got it).
		fix: (
			client: PoolClient,
			actor: FixActor,
			form: FormData
		) => Promise<string | { message: string; personId: string }>
	) => {
		const actor = actorOf(event);
		if (!actor) return fail(403, { error: 'Forbidden' });
		const form = await event.request.formData();
		let personId = formText(form, 'person_id') || undefined;
		const result = await runFaceFix(name, actor.id, async (client) => {
			const done = await fix(client, actor, form);
			if (typeof done === 'string') return done;
			personId = done.personId;
			return done.message;
		});
		return 'status' in result
			? fail(result.status, { error: result.data.message, personId })
			: { ...result, personId };
	};

	return {
		// "Same people?": each new face at the shift end joins the start worker picked for it.
		samePeople: (event) =>
			run(event, 'same_people', async (client, actor, form) => {
				const pumpId = event.url.searchParams.get('pump') || '';
				const day = event.url.searchParams.get('day') || '';
				if (!UUID_PATTERN.test(pumpId) || !isDateKey(day))
					throw new FaceFixError('Pump not found.');
				return mergedMessage(await mergeSamePeople(client, { pumpId, day, form, actor }));
			}),
		correct: async (event) => {
			const actor = actorOf(event);
			if (!actor) return fail(403, { error: 'Forbidden' });
			try {
				const result = await saveCorrection(actor, await event.request.formData());
				if (result.error)
					return fail(result.status, { error: result.error, personId: result.personId });
				return { success: true, personId: result.personId, message: result.message };
			} catch (err) {
				logger.error(
					{ error: String((err as any)?.message || err) },
					'attendance correction failed'
				);
				return fail(500, { error: 'Could not save the attendance correction' });
			}
		},
		// A worker the camera never detected on this day: a new worker, counted for one photo.
		addMissedWorker: (event) =>
			run(event, 'add_missed_worker', async (client, actor, form) => {
				const sessionId = formText(form, 'session_id');
				if (!UUID_PATTERN.test(sessionId))
					throw new FaceFixError('Choose shift start or shift end.');
				const { rows } = await client.query(
					'SELECT pump_id FROM attendance_sessions WHERE id = $1',
					[sessionId]
				);
				if (!rows[0] || !(await allowedPump(client, actor, rows[0].pump_id)))
					throw new FaceFixError('Pump not found.');
				await markPresent(client, {
					sessionId,
					personId: null,
					name: formText(form, 'name'),
					actor
				});
				return `${formText(form, 'name')} added and marked present.`;
			}),
		// A face counted for the wrong worker in one photo: it goes to the right worker of the
		// pump, or to a new worker. That worker is then counted for the photo instead.
		moveFace: (event) =>
			run(event, 'move_face', async (client, actor, form) => {
				const sessionId = formText(form, 'session_id');
				const fromPersonId = formText(form, 'person_id');
				const toPersonId = formText(form, 'to_person_id') || null;
				if (
					![sessionId, fromPersonId].every((value) => UUID_PATTERN.test(value)) ||
					(toPersonId && !UUID_PATTERN.test(toPersonId))
				)
					throw new FaceFixError('Choose the photo and the right worker.');
				const name = formText(form, 'name');
				if (!toPersonId && !name)
					throw new FaceFixError("Pick the right worker, or enter a new worker's name.");
				const { rows } = await client.query(
					'SELECT pump_id FROM attendance_sessions WHERE id = $1',
					[sessionId]
				);
				if (!rows[0] || !(await allowedPump(client, actor, rows[0].pump_id)))
					throw new FaceFixError('Pump not found.');
				const result = await moveFace(client, {
					sessionId,
					fromPersonId,
					toPersonId,
					name: toPersonId ? undefined : name,
					actor
				});
				// The message shows on the worker who got the face: the old one may be retired.
				return {
					personId: result.personId,
					message: result.createdPerson
						? `Face moved to ${name}, a new worker counted for that photo.`
						: 'Face moved. This worker is now counted for that photo.'
				};
			}),
		markDuplicate: (event) => run(event, 'mark_duplicate', markDuplicate),
		undoDuplicate: (event) => run(event, 'undo_duplicate', undoDuplicate),
		rename: async (event) => {
			const actor = actorOf(event);
			if (!actor) return fail(403, { error: 'Forbidden' });
			const form = await event.request.formData();
			const personId = formText(form, 'person_id');
			const result = await renamePerson(actor, personId, form.get('name'));
			if (result.error) return fail(result.status, { error: result.error, personId });
			return { success: true, personId, message: `Name saved: ${result.name}` };
		}
	};
}
