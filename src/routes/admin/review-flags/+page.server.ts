import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { query } from '$lib/server/db';
import { resolveReviewFlag, type FlagFix } from '$lib/server/faceFixes';
import { formText, runFaceFix } from '$lib/server/faceFixActions';
import { pumpWorkers } from '$lib/server/pumpWorkers';
import { personDisplayLabel } from '$lib/personLabel';

// Flagged errors: every "Flag error" an admin raised on attendance evidence, open ones first,
// each closed with what was done (src/lib/server/faceFixes.ts).

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const load: PageServerLoad = async () => {
	const [open, closed] = await Promise.all([
		query<any>(
			`SELECT arf.id, arf.session_id, arf.person_id, arf.reason, arf.note, arf.created_at,
			        flagger.email AS flagged_by, s.session_date::text AS session_date, s.session_type,
			        s.photo_url IS NOT NULL AS has_photo, pu.id AS pump_id, pu.pump_code,
			        pl.name AS plant_name, p.display_seq, p.name, p.is_operator, afe.face_crop_url
			 FROM attendance_review_flags arf
			 JOIN attendance_sessions s ON s.id = arf.session_id
			 JOIN pumps pu ON pu.id = s.pump_id
			 JOIN plants pl ON pl.id = pu.plant_id
			 JOIN admins flagger ON flagger.id = arf.flagged_by_admin_id
			 LEFT JOIN persons p ON p.id = arf.person_id
			 LEFT JOIN attendance_face_evidence afe
			   ON afe.session_id = arf.session_id AND afe.person_id = arf.person_id
			 WHERE arf.status = 'open'
			 ORDER BY arf.created_at DESC LIMIT 100`
		),
		query<any>(
			`SELECT arf.id, arf.reason, arf.resolution, arf.resolved_at,
			        s.session_date::text AS session_date, s.session_type, pu.pump_code,
			        resolver.email AS resolved_by, p.display_seq, p.name, p.is_operator
			 FROM attendance_review_flags arf
			 JOIN attendance_sessions s ON s.id = arf.session_id
			 JOIN pumps pu ON pu.id = s.pump_id
			 LEFT JOIN admins resolver ON resolver.id = arf.resolved_by_admin_id
			 LEFT JOIN persons p ON p.id = arf.resolved_person_id
			 WHERE arf.status = 'resolved'
			 ORDER BY arf.resolved_at DESC NULLS LAST LIMIT 30`
		)
	]);

	const workers = await pumpWorkers(
		open.map((flag) => flag.pump_id),
		open.map((flag) => flag.session_id)
	);
	return {
		flags: open.map((flag) => ({
			...flag,
			worker: flag.person_id
				? personDisplayLabel(flag.pump_code, flag.display_seq, flag.is_operator, flag.name)
				: null,
			// Workers this flag can be fixed to: the pump's workers not already in the photo.
			candidates: workers.forSession(flag.pump_id, flag.session_id)
		})),
		closed: closed.map((flag) => ({
			...flag,
			worker:
				flag.display_seq != null
					? personDisplayLabel(flag.pump_code, flag.display_seq, flag.is_operator, flag.name)
					: null
		}))
	};
};

const MESSAGES: Record<FlagFix['action'], string> = {
	move: 'Face moved to the right worker. Flag closed.',
	new_worker: 'Face moved to a new worker. Flag closed.',
	mark_present: 'Worker marked present for this photo. Flag closed.',
	dismiss: 'Flag dismissed. Nothing was changed.'
};

async function closeFlag(request: Request, adminId: string, build: (form: FormData) => FlagFix) {
	const form = await request.formData();
	const id = formText(form, 'id');
	if (!UUID_PATTERN.test(id)) return fail(400, { success: false, message: 'Invalid request.' });
	const fix = build(form);
	return runFaceFix(`review_flag_${fix.action}`, adminId, async (client) => {
		await resolveReviewFlag(client, id, adminId, fix);
		return MESSAGES[fix.action];
	});
}

export const actions: Actions = {
	// One face counted for the wrong worker: the admin picks the right worker or a new one.
	moveFace: async ({ request, locals }) =>
		closeFlag(request, locals.user!.id, (form) => {
			const personId = formText(form, 'person_id');
			return personId
				? { action: 'move', personId }
				: { action: 'new_worker', name: formText(form, 'name') };
		}),
	// A worker missing from the photo: count an existing worker or a new one by name.
	markPresent: async ({ request, locals }) =>
		closeFlag(request, locals.user!.id, (form) => ({
			action: 'mark_present',
			personId: formText(form, 'person_id') || null,
			name: formText(form, 'name')
		})),
	dismiss: async ({ request, locals }) =>
		closeFlag(request, locals.user!.id, () => ({ action: 'dismiss' }))
};
