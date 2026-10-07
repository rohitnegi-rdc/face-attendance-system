<script lang="ts">
	import { formatDayLabel } from '$lib/date';

	// Hand-rolled inline SVG stacked-bar chart — no charting library dependency, matching
	// $lib/sparkline.ts's existing rule. One bar per day, segmented Present / Morning-only /
	// Evening-only / Absent, all scaled to the same max so days are directly comparable.
	let { data = [] } = $props<{
		data: {
			day: string;
			present: number;
			morningOnly: number;
			eveningOnly: number;
			absent: number;
		}[];
	}>();
	const orderedData = $derived([...data].sort((a, b) => b.day.localeCompare(a.day)));

	const barWidth = 64;
	const gap = 24;
	const padding = 16;
	const barAreaHeight = 220;
	const labelAreaHeight = 56;

	const chartWidth = $derived(
		orderedData.length ? padding * 2 + orderedData.length * (barWidth + gap) - gap : padding * 2
	);
	const chartHeight = barAreaHeight + labelAreaHeight;

	const maxTotal = $derived(
		Math.max(...orderedData.map((d: any) => d.present + d.morningOnly + d.eveningOnly + d.absent), 1)
	);

	function segments(d: {
		present: number;
		morningOnly: number;
		eveningOnly: number;
		absent: number;
	}) {
		const order = [
			{ key: 'present', value: d.present, cls: 'seg-present' },
			{ key: 'morningOnly', value: d.morningOnly, cls: 'seg-morning' },
			{ key: 'eveningOnly', value: d.eveningOnly, cls: 'seg-evening' },
			{ key: 'absent', value: d.absent, cls: 'seg-absent' }
		];
		let cumulative = 0;
		return order.map((seg) => {
			const height = maxTotal ? (seg.value / maxTotal) * barAreaHeight : 0;
			const y = barAreaHeight - cumulative - height;
			cumulative += height;
			return { ...seg, y, height };
		});
	}

	function barX(i: number) {
		return padding + i * (barWidth + gap);
	}

	const summaryLabel = $derived(
		`Attendance trend for the last ${orderedData.length} days, newest first: ` +
			orderedData
				.map((d: any) => {
					const label = formatDayLabel(d.day);
					return `${label.weekday} ${label.date}: ${d.present} present, ${d.morningOnly} morning only, ${d.eveningOnly} evening only, ${d.absent} absent`;
				})
				.join('; ')
	);
</script>

<svg
	class="daily-bars"
	width={chartWidth}
	height={chartHeight}
	viewBox={`0 0 ${chartWidth} ${chartHeight}`}
	role="img"
	aria-label={summaryLabel}
>
	{#each orderedData as d, i}
		{@const x = barX(i)}
		{@const label = formatDayLabel(d.day)}
		{@const total = d.present + d.morningOnly + d.eveningOnly + d.absent}
		<g>
			{#each segments(d) as seg}
				{#if seg.value > 0}
					<rect class={seg.cls} {x} y={seg.y} width={barWidth} height={seg.height}>
						<title>{seg.key}: {seg.value}</title>
					</rect>
				{/if}
				{#if seg.value > 0 && seg.key !== 'absent'}
					<text
						class="seg-label {seg.cls}-label"
						x={x + barWidth / 2}
						y={seg.y + seg.height / 2}
						text-anchor="middle"
						dominant-baseline="central">{seg.value}</text
					>
				{/if}
			{/each}
			<rect class="bar-outline" {x} y={0} width={barWidth} height={barAreaHeight} fill="none" />
			<text class="total-label" x={x + barWidth / 2} y={12} text-anchor="middle">{total}</text>
			<text class="day-label" x={x + barWidth / 2} y={barAreaHeight + 16} text-anchor="middle"
				>{label.weekday}</text
			>
			<text
				class="day-label day-label--muted"
				x={x + barWidth / 2}
				y={barAreaHeight + 32}
				text-anchor="middle">{label.date}</text
			>
		</g>
	{/each}
</svg>

<div class="legend" aria-label="Attendance trend legend">
	<span><b class="legend__swatch legend__swatch--present"></b> Present</span>
	<span><b class="legend__swatch legend__swatch--morning"></b> Morning only</span>
	<span><b class="legend__swatch legend__swatch--evening"></b> Evening only</span>
	<span><b class="legend__swatch legend__swatch--absent"></b> Absent</span>
</div>

<style>
	.daily-bars {
		display: block;
		width: 100%;
		height: auto;
		overflow: visible;
	}

	.seg-present {
		fill: var(--brand-teal);
	}
	.seg-morning {
		fill: var(--surface-muted);
	}
	.seg-evening {
		fill: var(--brand-mist);
	}
	.seg-absent {
		fill: var(--brand-white);
		stroke: var(--brand-mist);
		stroke-width: 1;
	}

	.bar-outline {
		stroke: var(--brand-mist);
		stroke-width: 1;
	}

	.seg-label {
		font-size: 13px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		pointer-events: none;
	}
	.seg-present-label {
		fill: var(--brand-white);
	}
	.seg-morning-label {
		fill: var(--ink-default);
	}
	.seg-evening-label {
		fill: var(--ink-strong);
	}

	.day-label {
		font-size: 12px;
		font-weight: 700;
		fill: var(--ink-default);
	}
	.day-label--muted {
		font-weight: 500;
		fill: var(--ink-muted);
	}
	.total-label {
		font-size: 11px;
		font-weight: 700;
		fill: var(--ink-muted);
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		margin-top: var(--space-2);
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
	}
	.legend__swatch {
		display: inline-block;
		width: 0.9rem;
		height: 0.9rem;
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-sm);
	}
	.legend__swatch--present {
		background: var(--brand-teal);
	}
	.legend__swatch--morning {
		background: var(--surface-muted);
	}
	.legend__swatch--evening {
		background: var(--brand-mist);
	}
	.legend__swatch--absent {
		background: var(--brand-white);
	}
</style>
