// Shift start location check: the operator's phone position against the pump's latest GPS
// reading (copied from the optimizer database every 5 minutes by worker/gpsFeed.js into
// pump_locations).
// Within range the shift starts normally; otherwise it starts on hold and the plant manager is
// emailed to approve or reject it. Only areas with location_check_enabled are checked.
import { escapeHtml, mailEnabled, mailer, mailFrom } from '$lib/server/mail';
import type { PoolClient } from 'pg';
import { query } from '$lib/server/db';
import { logger } from '$lib/server/log';

export const LOCATION_RADIUS_M = 100;
// Pumps report about every 10 minutes and the worker copies every 5; 30 minutes allows a missed
// report before the reading counts as stale.
export const PUMP_GPS_MAX_AGE_MINUTES = 30;

// SQL condition: the pump's shift on that date started on hold or was rejected, so reports leave
// the whole day out until the plant manager approves it.
export const heldShiftDay = (pumpColumn: string, dateColumn: string) =>
	`EXISTS (SELECT 1 FROM attendance_sessions held
	         WHERE held.pump_id = ${pumpColumn} AND held.session_date = ${dateColumn}
	           AND held.session_type = 'morning' AND held.location_status IN ('pending', 'rejected'))`;

export type LocationIssue = 'too_far' | 'no_phone_location' | 'no_pump_gps' | 'stale_pump_gps';

export type LocationCheck = {
	status: 'ok' | 'pending';
	issue: LocationIssue | null;
	distanceM: number | null;
	pumpLat: number | null;
	pumpLng: number | null;
	pumpAt: Date | null;
};

// Great-circle distance in metres.
export function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number) {
	const rad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = rad(lat2 - lat1);
	const dLng = rad(lng2 - lng1);
	const a =
		Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
	return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

export function validCoordinate(lat: number | null, lng: number | null) {
	return (
		lat !== null &&
		lng !== null &&
		Number.isFinite(lat) &&
		Number.isFinite(lng) &&
		Math.abs(lat) <= 90 &&
		Math.abs(lng) <= 180 &&
		!(lat === 0 && lng === 0)
	);
}

// The plain-words reason shown to the operator, in the email and on the approval page.
export function locationIssueText(
	issue: string | null,
	distanceM: number | null,
	pumpAt: Date | string | null
) {
	switch (issue) {
		case 'too_far':
			return `The operator was ${distanceM ?? '?'} m from the pump (allowed: ${LOCATION_RADIUS_M} m).`;
		case 'no_phone_location':
			return "The operator's phone did not share its location.";
		case 'no_pump_gps':
			return 'No GPS position has been received for this pump.';
		case 'stale_pump_gps': {
			const minutes = pumpAt ? Math.round((Date.now() - new Date(pumpAt).getTime()) / 60000) : null;
			return `The pump's last GPS position is ${minutes ?? 'over ' + PUMP_GPS_MAX_AGE_MINUTES} minutes old, so the distance could not be checked.`;
		}
		default:
			return '';
	}
}

// null = this pump's area does not use the location check.
export async function checkShiftStartLocation(
	client: PoolClient,
	pumpId: string,
	phoneLat: number | null,
	phoneLng: number | null
): Promise<LocationCheck | null> {
	const { rows } = await client.query(
		`SELECT a.location_check_enabled AS enabled, l.lat, l.lng, l.recorded_at
		 FROM pumps pu JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		 LEFT JOIN LATERAL (
		   SELECT lat, lng, recorded_at FROM pump_locations
		   WHERE pump_id = pu.id ORDER BY recorded_at DESC LIMIT 1
		 ) l ON true
		 WHERE pu.id = $1`,
		[pumpId]
	);
	const row = rows[0];
	if (!row?.enabled) return null;

	const pump = {
		pumpLat: row.lat as number | null,
		pumpLng: row.lng as number | null,
		pumpAt: row.recorded_at as Date | null
	};
	const hold = (issue: LocationIssue, distanceM: number | null = null): LocationCheck => ({
		status: 'pending',
		issue,
		distanceM,
		...pump
	});

	const hasPhone = validCoordinate(phoneLat, phoneLng);
	const distanceM =
		hasPhone && row.lat !== null
			? Math.round(distanceMetres(phoneLat!, phoneLng!, row.lat, row.lng))
			: null;
	if (!hasPhone) return hold('no_phone_location');
	if (row.lat === null) return hold('no_pump_gps');
	const ageMinutes = (Date.now() - new Date(row.recorded_at).getTime()) / 60000;
	if (ageMinutes > PUMP_GPS_MAX_AGE_MINUTES) return hold('stale_pump_gps', distanceM);
	if (distanceM! > LOCATION_RADIUS_M) return hold('too_far', distanceM);
	return { status: 'ok', issue: null, distanceM, ...pump };
}

// Best effort: the session row is the source of truth and the manager also sees it on the
// Approvals page, so a mail failure is logged, never thrown.
export async function sendLocationApprovalEmail(sessionId: string, approvalUrl: string) {
	try {
		const client = mailer();
		const [info] = await query<{
			pump_code: string;
			plant_name: string;
			issue: string;
			distance_m: number | null;
			pump_gps_at: Date | null;
			sent_at: string;
		}>(
			`SELECT pu.pump_code, pl.name AS plant_name, s.location_issue AS issue,
			        s.location_distance_m AS distance_m, s.pump_gps_at,
			        to_char(s.submitted_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, HH12:MI am') AS sent_at
			 FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
			 JOIN plants pl ON pl.id = pu.plant_id WHERE s.id = $1`,
			[sessionId]
		);
		const managers = await query<{ email: string }>(
			`SELECT pm.email FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
			 JOIN plant_manager_assignments pma ON pma.plant_id = pu.plant_id
			 JOIN plant_managers pm ON pm.id = pma.manager_id WHERE s.id = $1`,
			[sessionId]
		);
		const to = managers.map((m) => m.email).filter(Boolean);
		if (!info) return;
		if (!mailEnabled()) {
			logger.info(
				{
					sessionId,
					to,
					cc: process.env.FRAUD_ALERT_CC_EMAIL || null,
					subject:
						info.issue === 'too_far'
							? `Approve attendance: ${info.pump_code} operator was ${info.distance_m} m from the pump`
							: `Approve attendance: ${info.pump_code} location could not be verified`,
					reason: locationIssueText(info.issue, info.distance_m, info.pump_gps_at),
					approvalUrl
				},
				'location approval email NOT sent (mail off)'
			);
			return;
		}
		if (!client || !to.length) {
			logger.warn(
				{ sessionId, smtp: Boolean(client), managers: to.length },
				'location approval email skipped (no SMTP or no plant manager)'
			);
			return;
		}
		const reason = locationIssueText(info.issue, info.distance_m, info.pump_gps_at);
		const subject =
			info.issue === 'too_far'
				? `Approve attendance: ${info.pump_code} operator was ${info.distance_m} m from the pump`
				: `Approve attendance: ${info.pump_code} location could not be verified`;
		const html = `
			<p>A shift start at pump <strong>${escapeHtml(info.pump_code)}</strong> (${escapeHtml(info.plant_name)}) needs your approval.</p>
			<p><strong>Problem:</strong> ${escapeHtml(reason)}</p>
			<p><strong>Photo sent:</strong> ${escapeHtml(info.sent_at)}</p>
			<p>Please call the operator to verify, then approve or reject. The attendance is not counted in reports until you approve it.</p>
			<p><a href="${approvalUrl}" style="display:inline-block;padding:10px 18px;background:#0b6e69;color:#fff;border-radius:6px;text-decoration:none">Open approval</a></p>`;
		await client.sendMail({
			from: mailFrom(),
			to,
			cc: process.env.FRAUD_ALERT_CC_EMAIL || undefined,
			subject,
			text: `${subject}\n\n${reason}\nPhoto sent: ${info.sent_at}\n\nApprove or reject: ${approvalUrl}`,
			html
		});
		logger.info({ sessionId, to }, 'location approval email sent');
	} catch (err: any) {
		logger.error(
			{ sessionId, error: String(err?.message || err) },
			'location approval email failed'
		);
	}
}
