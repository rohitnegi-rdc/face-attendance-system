<script lang="ts">
	let { metrics, testId } = $props<{
		metrics: { label: string; value: string | number; detail?: string }[];
		testId?: string;
	}>();
</script>

<div class="metric-strip" data-testid={testId}>
	{#each metrics as metric}
		<div class="metric">
			<span class="metric__label">{metric.label}</span>
			<strong class="metric__value">{metric.value}</strong>
			{#if metric.detail}<span class="metric__detail">{metric.detail}</span>{/if}
		</div>
	{/each}
</div>
