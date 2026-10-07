// Fraud-alert email — sent when the whole-photo spoof check disables a pump. The worker is a
// plain Node process (no SvelteKit $lib alias), so this lives alongside worker/index.js and is
// wired to the same root node_modules (docker-compose's worker service builds from the same
// image as the app, see "build: ."). SMTP creds are intentionally optional: if SMTP_HOST isn't
// set, sending is skipped with a log line instead of crashing the worker — the fraud lockout
// and DB state are the source of truth; email is a best-effort notification on top of it.
import nodemailer from 'nodemailer';

let transporter;
function getTransporter() {
	if (!process.env.SMTP_HOST) return null;
	if (!transporter) {
		transporter = nodemailer.createTransport({
			host: process.env.SMTP_HOST,
			port: Number(process.env.SMTP_PORT ?? 587),
			secure: process.env.SMTP_SECURE === 'true',
			auth: process.env.SMTP_USER
				? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
				: undefined
		});
	}
	return transporter;
}

export async function sendFraudAlertEmail(
	{
		plantManagerEmail,
		plantManagerName,
		plantName,
		areaName,
		pumpCode,
		sessionType,
		sessionDate,
		photoBuffer,
		photoFilename
	},
	log
) {
	const to = [plantManagerEmail].filter(Boolean);
	const cc = [process.env.FRAUD_ALERT_CC_EMAIL].filter(Boolean);
	const client = getTransporter();

	if (!client) {
		log('warn', { pumpCode, plantManagerEmail }, 'fraud alert email skipped — SMTP not configured');
		return;
	}
	if (to.length === 0 && cc.length === 0) {
		log(
			'warn',
			{ pumpCode, plantName },
			'fraud alert email skipped — no plant manager email on file and no CC configured'
		);
		return;
	}

	const subject = `Fraud alert: Fake photo detected at pump ${pumpCode}`;
	const html = `
		<p>A submitted attendance photo at pump <strong>${pumpCode}</strong>${plantName ? ` (${plantName}${areaName ? `, ${areaName}` : ''})` : ''} was flagged as a fake/screen-replay image by the automated anti-spoofing check.</p>
		<p><strong>Session:</strong> ${sessionType ?? 'unknown'} &middot; ${sessionDate ?? 'unknown date'}</p>
		<p>The pump's login has been disabled and no attendance was recorded from this photo. The flagged photo is attached.</p>
		<p>If this was not actually fraud, an admin can review it from the admin panel and mark it normal, which restores the pump's login and reprocesses this photo for real attendance.</p>
		${plantManagerName ? `<p>Sent to: ${plantManagerName}</p>` : ''}
	`;

	try {
		await client.sendMail({
			from: process.env.SMTP_FROM || process.env.SMTP_USER,
			to: to.length ? to.join(', ') : undefined,
			cc: cc.length ? cc.join(', ') : undefined,
			subject,
			html,
			attachments: photoBuffer
				? [{ filename: photoFilename || 'fraud-photo.jpg', content: photoBuffer }]
				: []
		});
		log('info', { pumpCode, to, cc }, 'fraud alert email sent');
	} catch (err) {
		log('error', { pumpCode, error: err.message }, 'fraud alert email failed to send');
	}
}
