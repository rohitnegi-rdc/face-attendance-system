// Stable, human-readable person label — replaces raw UUID slices across the admin/vendor/pump UI.
// isOperator (persons.is_operator) tags the pump operator, who is counted like any worker.
// name (persons.name, set by the operator) leads when present; the worker number stays beside it
// because it is the stable id people already know from older reports.
export function personDisplayLabel(
	pumpCode: string,
	displaySeq: number,
	isOperator = false,
	name: string | null = null
): string {
	const operator = isOperator ? ' (Operator)' : '';
	return `${name ? `${name} · ` : ''}${pumpCode} Worker ${displaySeq}${operator}`;
}

// Short form for places that already show the pump (face tiles, the fraud case page).
export function personShortLabel(displaySeq: number, isOperator = false, name: string | null = null) {
	const operator = isOperator ? ' (Operator)' : '';
	return name ? `${name}${operator}` : `Worker ${displaySeq}${operator}`;
}

// Letters in any script (Hindi names too), digits, space and . ' - ; must start with a letter.
const NAME_PATTERN = /^\p{L}[\p{L}\p{M}\p{N} .'-]*$/u;

// Tidy and check an entered name. Returns the name, or null when it is not usable.
export function cleanPersonName(raw: unknown): string | null {
	const name = String(raw ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	if (name.length < 2 || name.length > 60 || !NAME_PATTERN.test(name)) return null;
	return name;
}
