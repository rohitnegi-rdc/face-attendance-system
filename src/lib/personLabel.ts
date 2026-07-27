// Stable, human-readable person label — replaces raw UUID slices across the admin/vendor/pump UI.
export function personDisplayLabel(pumpCode: string, displaySeq: number): string {
	return `${pumpCode} Worker ${displaySeq}`;
}
