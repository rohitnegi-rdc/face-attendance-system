// Inline SVG sparkline renderer — no charting library dependency (per plan's "General rules").
export function sparklinePath(values: number[], width = 100, height = 24): string {
	if (values.length === 0) return '';
	const max = Math.max(...values, 1);
	const min = Math.min(...values, 0);
	const range = max - min || 1;
	const stepX = width / Math.max(values.length - 1, 1);
	return values
		.map((v, i) => {
			const x = i * stepX;
			const y = height - ((v - min) / range) * height;
			return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(' ');
}
