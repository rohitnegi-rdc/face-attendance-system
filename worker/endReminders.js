// Shift end reminders by Web Push (migration 040). The moment the evening gap has passed since a
// shift start (the shift can end) and no shift end photo has come, every phone that allowed
// notifications for that pump gets "time to end the shift"; then one every 15 minutes while the
// end is still missing. Never more than four per shift. Each reminder is claimed by one UPDATE,
// so two workers cannot both send it. A phone the push service no longer knows (404/410) is
// removed.
import webpush from 'web-push';

export const REMINDER_EVERY_MINUTES = 15;
export const MAX_REMINDERS = 4;

// Same precedence as src/lib/server/settings.ts: admin setting > env > default (540 = 9 hours).
async function eveningGapMinutes(db) {
	const { rows } = await db.query(
		`SELECT value FROM app_settings WHERE key = 'evening_min_gap_minutes'`
	);
	const stored = Number(rows[0]?.value);
	if (Number.isInteger(stored) && stored > 0) return stored;
	const fromEnv = Number(process.env.EVENING_MIN_GAP_MINUTES);
	return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 540;
}

function duration(minutes, hindi) {
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return hindi ? `${hours} घंटे` : `${hours} hour${hours === 1 ? '' : 's'}`;
	}
	return hindi ? `${minutes} मिनट` : `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// Hindi first, then English: the phone shows it before the pump screen's language choice loads.
function message(reminder, gapMinutes, sessionId) {
	const first = reminder === 1;
	const last = reminder === MAX_REMINDERS;
	return {
		title: first
			? 'शिफ्ट एंड करने का समय / Time to end the shift'
			: last
				? 'आखिरी रिमाइंडर: शिफ्ट एंड करें / Last reminder: end the shift'
				: 'शिफ्ट एंड अभी बाकी है / Shift end is still pending',
		body: first
			? `${duration(gapMinutes, true)} पूरे हो गए। अब शिफ्ट एंड की फोटो लें।\n` +
				`${duration(gapMinutes, false)} are done. Take the Shift end photos now.`
			: `कृपया अभी शिफ्ट एंड की फोटो लें। (रिमाइंडर ${reminder}/${MAX_REMINDERS})\n` +
				`Please take the Shift end photos now. (Reminder ${reminder} of ${MAX_REMINDERS})`,
		// Each reminder replaces the one before on the phone instead of stacking.
		tag: `shift-end-${sessionId}`,
		url: 'pump'
	};
}

export async function sendEndReminders(db, log, pairingWindowHours) {
	const {
		rows: [keys]
	} = await db.query('SELECT public_key, private_key, subject FROM push_keys');
	if (!keys) return 0; // No phone has allowed notifications yet.
	const gapMinutes = await eveningGapMinutes(db);

	// An open shift start whose gap has passed, still without a shift end photo (a failed one
	// does not count), on a pump with at least one phone to tell.
	const { rows: due } = await db.query(
		`UPDATE attendance_sessions s
		 SET end_reminders_sent = s.end_reminders_sent + 1, end_reminder_at = now()
		 WHERE s.session_type = 'morning' AND s.status = 'completed' AND s.pairing_status = 'open'
		   AND s.submitted_at > now() - ($2 || ' hours')::interval
		   AND ((s.end_reminders_sent = 0 AND s.submitted_at <= now() - $1 * interval '1 minute')
		     OR (s.end_reminders_sent BETWEEN 1 AND $4::int - 1
		         AND s.end_reminder_at <= now() - $3 * interval '1 minute'))
		   AND NOT EXISTS (
		     SELECT 1 FROM attendance_sessions e
		     WHERE e.pump_id = s.pump_id AND e.session_type = 'evening'
		       AND e.submitted_at > s.submitted_at AND e.status <> 'failed')
		   AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.pump_id = s.pump_id)
		 RETURNING s.id, s.pump_id, s.end_reminders_sent AS reminder`,
		[gapMinutes, String(await pairingWindowHours(db)), REMINDER_EVERY_MINUTES, MAX_REMINDERS]
	);

	const vapidDetails = {
		subject: keys.subject,
		publicKey: keys.public_key,
		privateKey: keys.private_key
	};
	for (const shift of due) {
		const { rows: phones } = await db.query(
			'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE pump_id = $1',
			[shift.pump_id]
		);
		const payload = JSON.stringify(message(shift.reminder, gapMinutes, shift.id));
		let delivered = 0;
		for (const phone of phones) {
			let status;
			try {
				// web-push encrypts and signs; fetch sends. sendNotification itself always speaks
				// https, even to an http:// address, so the regression stub could not receive it.
				const request = webpush.generateRequestDetails(
					{ endpoint: phone.endpoint, keys: { p256dh: phone.p256dh, auth: phone.auth } },
					payload,
					{ vapidDetails, TTL: 60 * 60, urgency: 'high' }
				);
				const response = await fetch(request.endpoint, {
					method: request.method,
					headers: request.headers,
					body: request.body,
					signal: AbortSignal.timeout(10_000)
				});
				status = response.status;
				if (response.ok) {
					delivered++;
					await db.query('UPDATE push_subscriptions SET last_sent_at = now() WHERE id = $1', [
						phone.id
					]);
					continue;
				}
				if (status === 404 || status === 410) {
					await db.query('DELETE FROM push_subscriptions WHERE id = $1', [phone.id]);
					log('info', { pumpId: shift.pump_id }, 'push subscription gone, removed');
					continue;
				}
				log('warn', { pumpId: shift.pump_id, status }, 'shift end reminder not delivered');
			} catch (err) {
				log(
					'warn',
					{ pumpId: shift.pump_id, status, error: String(err?.message || err) },
					'shift end reminder not delivered'
				);
			}
		}
		log(
			'info',
			{ sessionId: shift.id, pumpId: shift.pump_id, reminder: shift.reminder, delivered },
			'shift end reminder sent'
		);
	}
	return due.length;
}
