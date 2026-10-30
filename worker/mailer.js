// Fraud-alert email — sent when the whole-photo spoof check disables a pump. The worker is a
// plain Node process (no SvelteKit $lib alias), so this lives alongside worker/index.js and is
// wired to the same root node_modules (docker-compose's worker service builds from the same
// image as the app, see "build: ."). SMTP creds are intentionally optional: if SMTP_HOST isn't
// set, sending is skipped with a log line instead of crashing the worker — the fraud lockout
// and DB state are the source of truth; email is a best-effort notification on top of it.
import nodemailer from 'nodemailer';

// DD-MM-YYYY, the date format used everywhere in the app. A DATE column can arrive as a
// "YYYY-MM-DD" string or as a Date at local midnight, so both are read by their date parts.
function formatSessionDate(value) {
	if (!value) return 'unknown date';
	if (value instanceof Date) {
		const pad = (n) => String(n).padStart(2, '0');
		return `${pad(value.getDate())}-${pad(value.getMonth() + 1)}-${value.getFullYear()}`;
	}
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
	return m ? `${m[3]}-${m[2]}-${m[1]}` : String(value);
}

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

	// Same rule as src/lib/server/mail.ts: only the production server sets MAIL_ENABLED=true.
	if (process.env.MAIL_ENABLED !== 'true') {
		log('info', { pumpCode, to, cc }, 'fraud alert email NOT sent (mail off)');
		return;
	}
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
		<p><strong>Session:</strong> ${sessionType ?? 'unknown'} &middot; ${formatSessionDate(sessionDate)}</p>
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

const escapeHtml = (value) =>
	String(value ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
	);

// The monitor's 8 pm list (worker/monitorDigest.js): one line per pump that needs a look.
export async function sendMonitorDigestEmail({ to, name, day, pumps }, log) {
	if (process.env.MAIL_ENABLED !== 'true') {
		log('info', { to, pumps: pumps.length }, 'monitor digest email NOT sent (mail off)');
		return;
	}
	const client = getTransporter();
	if (!client) {
		log('warn', { pumps: pumps.length }, 'monitor digest email skipped — SMTP not configured');
		return;
	}
	const rows = pumps
		.map(
			(p) =>
				`<tr><td><strong>${escapeHtml(p.pump_code)}</strong></td><td>${escapeHtml(p.plant_name)}, ${escapeHtml(p.area_name)}</td><td>${escapeHtml(p.problems.join(', '))}</td></tr>`
		)
		.join('');
	const html = `
		<p>Hello ${escapeHtml(name)},</p>
		<p>${pumps.length} ${pumps.length === 1 ? 'pump needs' : 'pumps need'} a look for ${formatSessionDate(day)}:</p>
		<table cellpadding="6" style="border-collapse:collapse">
			<tr><th align="left">Pump</th><th align="left">Plant</th><th align="left">Needs a look</th></tr>
			${rows}
		</table>
		<p>Sign in to Face Attendance and open Attendance to fix these pumps.</p>
	`;
	try {
		await client.sendMail({
			from: process.env.SMTP_FROM || process.env.SMTP_USER,
			to,
			subject: `${pumps.length} ${pumps.length === 1 ? 'pump needs' : 'pumps need'} a look, ${formatSessionDate(day)}`,
			html
		});
		log('info', { pumps: pumps.length }, 'monitor digest email sent');
	} catch (err) {
		log('error', { error: err.message }, 'monitor digest email failed to send');
	}
}
