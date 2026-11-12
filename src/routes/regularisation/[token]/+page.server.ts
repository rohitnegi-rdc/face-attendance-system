import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { decide, humanTime, readDecisionLink } from '$lib/server/regularisation';

// The page the email's Approve and Reject buttons open. Opening it decides nothing (mail scanners
// open links on their own); it shows the request again and decides when its button is pressed.
// The signed link stands in for a sign-in, for the approver it was sent to only.
export const load: PageServerLoad = async ({ params, url }) => {
	const link = await readDecisionLink(params.token);
	if (!link) return { state: 'invalid' as const };
	const f = link.facts;
	return {
		state: !link.allowed ? ('not_yours' as const) : ('open' as const),
		chosen: url.searchParams.get('do') === 'reject' ? 'reject' : 'approve',
		deciderName: link.deciderName,
		request: {
			pumpCode: f.pump_code,
			plantName: f.plant_name,
			areaName: f.area_name,
			plantManagerName: f.plant_manager_name,
			day: f.day,
			reason: f.reason,
			note: f.note,
			hasVoice: f.has_voice,
			requestedByRole: f.requested_by_role,
			requestedByName: f.requested_by_name,
			requestedAt: humanTime(f.requested_at),
			status: f.status,
			decidedByName: f.decided_by_name,
			decidedAt: f.decided_at ? humanTime(f.decided_at) : null,
			decisionReason: f.decision_reason,
			workers: link.workers,
			monthCount: f.month_count,
			lastPhotoDay: f.last_photo_day
		}
	};
};

async function decideWith(token: string, request: Request, approve: boolean) {
	const link = await readDecisionLink(token);
	if (!link?.allowed) return fail(403, { message: 'This link cannot decide the request.' });
	const form = await request.formData();
	const result = await decide(link.decider, link.facts.id, {
		approve,
		rejectReason: String(form.get('reject_reason') || ''),
		note: String(form.get('note') || '')
	});
	if (!result.ok) return fail(result.status, { message: result.error });
	return { done: approve ? 'approved' : 'rejected' };
}

export const actions: Actions = {
	approve: ({ params, request }) => decideWith(params.token, request, true),
	reject: ({ params, request }) => decideWith(params.token, request, false)
};
