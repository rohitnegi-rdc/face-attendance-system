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

// Testing (regression, LAN): log exactly what would be mailed, send nothing.
export const mailLogOnly = () => process.env.MAIL_LOG_ONLY === 'true';

export const escapeHtml = (value: string) =>
	value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
