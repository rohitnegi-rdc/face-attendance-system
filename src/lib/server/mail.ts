import nodemailer from 'nodemailer';

// One SMTP connection for every email the app sends. null when SMTP_HOST is not set (local
// development): callers log and skip, a mail is never the only record of anything.
let transporter: nodemailer.Transporter | null = null;
export function mailer() {
	if (!process.env.SMTP_HOST) return null;
	transporter ??= nodemailer.createTransport({
		host: process.env.SMTP_HOST,
		port: Number(process.env.SMTP_PORT ?? 587),
		secure: process.env.SMTP_SECURE === 'true',
		auth: process.env.SMTP_USER
			? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
			: undefined
	});
	return transporter;
}

export const mailFrom = () => process.env.SMTP_FROM || process.env.SMTP_USER;

// Email goes out only where MAIL_ENABLED=true, which is set on the production server alone.
// Everywhere else (local Docker, regression, scripts) callers log exactly what would be mailed and
// send nothing, so local testing never mails a real person, even with real SMTP settings loaded.
export const mailEnabled = () => process.env.MAIL_ENABLED === 'true';

export const escapeHtml = (value: string) =>
	value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
