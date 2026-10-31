// Whether a pump is working (pumps.work_status, migration 046). Inactive pumps are left out of the
// 9 am attendance tracker; Active and Idle ones are listed, a zero in red.
export const PUMP_WORK_STATUSES = ['active', 'idle', 'inactive'] as const;
export type PumpWorkStatus = (typeof PUMP_WORK_STATUSES)[number];
export const PUMP_WORK_STATUS_LABELS: Record<PumpWorkStatus, string> = {
	active: 'Active',
	idle: 'Idle',
	inactive: 'Inactive'
};
export const isPumpWorkStatus = (value: unknown): value is PumpWorkStatus =>
	PUMP_WORK_STATUSES.includes(value as PumpWorkStatus);
