// Who may see a worker's face: the admin, the pump itself, the vendor that owns the pump, and
// plant managers of the pump's plant. Used by the face image routes (/api/attendance/face/[id],
// /api/persons/[id]/face).
import { queryOne } from './db';

type User = { role: string; id: string };
type PumpRef = { pump_id: string; vendor_id: string; plant_id: string };

export async function canSeePump(user: User, pump: PumpRef) {
	if (user.role === 'admin') return true;
	if (user.role === 'pump') return pump.pump_id === user.id;
	if (user.role === 'vendor') return pump.vendor_id === user.id;
	if (user.role === 'plant-manager') {
		return Boolean(
			await queryOne(
				'SELECT 1 FROM plant_manager_assignments WHERE manager_id = $1 AND plant_id = $2',
				[user.id, pump.plant_id]
			)
		);
	}
	return false;
}

// A stored crop ("data:image/jpeg;base64,...") as an image response that the browser caches.
export function cropResponse(dataUrl: string | null | undefined) {
	const match = dataUrl?.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
	if (!match) return null;
	return new Response(Buffer.from(match[2], 'base64'), {
		headers: {
			'content-type': match[1],
			'cache-control': 'private, max-age=86400',
			'x-content-type-options': 'nosniff'
		}
	});
}
