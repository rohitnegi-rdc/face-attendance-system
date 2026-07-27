// Structured JSON logging — plans/MasterPlan.md §7a.
import pino from 'pino';

export const logger = pino({
	base: { service: 'sveltekit' },
	timestamp: () => `,"timestamp":"${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}"`
});
