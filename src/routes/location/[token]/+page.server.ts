import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { decideLocation, readLocationLink } from '$lib/server/locationDecision';

// The page the location approval email's Approve and Reject buttons open (worker/locationHold.js).
// Opening it decides nothing (mail scanners open links on their own); it shows the shift start
// again and decides when its button is pressed. The signed link stands in for a sign-in, for the
// plant manager or monitor it was sent to only, while they still look after that pump.
export const load: PageServerLoad = async ({ params, url }) => {
	const link = await readLocationLink(params.token);
	if (!link) return { state: 'invalid' as const };
	const f = link.facts;
	return {
		state: link.allowed ? ('open' as const) : ('not_yours' as const),
		chosen: url.searchParams.get('do') === 'reject' ? ('reject' as const) : ('approve' as const),
		deciderName: link.deciderName,
		shift: {
			pumpCode: f.pump_code as string,
			plantName: f.plant_name as string,
			areaName: f.area_name as string,
			sentAt: f.sent_at as string,
			problem: link.problem,
			waited: link.waited,
			faces: f.faces as number,
			hasPhoto: Boolean(f.photo_url),
			phone: f.gps_lat === null ? null : { lat: f.gps_lat as number, lng: f.gps_lng as number },
			pump:
				f.pump_gps_lat === null
					? null
					: { lat: f.pump_gps_lat as number, lng: f.pump_gps_lng as number },
			status: f.location_status as 'pending' | 'approved' | 'rejected',
			autoCleared: f.auto_cleared as boolean,
			decidedBy: f.decided_by as string | null,
			decidedAt: f.decided_at as string | null,
			note: f.location_note as string | null
		}
	};
};

async function decideWith(token: string, request: Request, approve: boolean) {
	const link = await readLocationLink(token);
	if (!link?.allowed) return fail(403, { message: 'This link cannot decide this shift start.' });
	const form = await request.formData();
	const result = await decideLocation(
		link.sessionId,
		link.managerId,
		approve ? 'approved' : 'rejected',
		form.get('note'),
		'email'
	);
	if (!result.ok) return fail(result.status, { message: result.error });
	return { done: approve ? ('approved' as const) : ('rejected' as const) };
}

export const actions: Actions = {
	approve: ({ params, request }) => decideWith(params.token, request, true),
	reject: ({ params, request }) => decideWith(params.token, request, false)
};
