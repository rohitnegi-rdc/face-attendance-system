<script lang="ts">
	import { sparklinePath } from '$lib/sparkline';

	let {
		values,
		width = 120,
		height = 32,
		label = 'Trend'
	} = $props<{
		values: number[];
		width?: number;
		height?: number;
		label?: string;
	}>();
</script>

<svg
	class="sparkline"
	{width}
	{height}
	viewBox={`0 0 ${width} ${height}`}
	role="img"
	aria-label={`${label}: ${values.join(', ')}`}
>
	<path d={sparklinePath(values, width, height)} fill="none" />
</svg>

<style>
	.sparkline {
		display: block;
		max-width: 100%;
		overflow: visible;
	}

	path {
		stroke: var(--brand-teal);
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
	}
</style>
