// Stable, human-readable person label — replaces raw UUID slices across the admin/vendor/pump UI.
// isOperator (persons.is_operator) tags the pump operator, who is counted like any worker.
export function personDisplayLabel(
	pumpCode: string,
	displaySeq: number,
	isOperator = false
): string {
	return `${pumpCode} Worker ${displaySeq}${isOperator ? ' (Operator)' : ''}`;
}
