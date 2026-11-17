<script lang="ts">
	// Workers of a day split by shift: full shift (start and end), start only, end only. The same
	// three counts as the 9 am attendance email and the plant manager's checklist, the same colours
	// as the attendance calendar (P / M / E). All three always show, so they can be compared.
	let {
		full,
		startOnly,
		endOnly,
		testId = 'shift-split'
	}: { full: number; startOnly: number; endOnly: number; testId?: string } = $props();
</script>

<span class="split" data-testid={testId}>
	<span class="split__item split__item--full" data-testid="split-full"
		><strong>{full}</strong> full shift</span
	>
	<span class="split__item split__item--start" data-testid="split-start"
		><strong>{startOnly}</strong> start only</span
	>
	<span class="split__item split__item--end" data-testid="split-end"
		><strong>{endOnly}</strong> end only</span
	>
</span>

<style>
	.split {
		display: inline-flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
	}
	.split__item {
		padding: 0.1rem 0.45rem;
		color: var(--ink-default);
		white-space: nowrap;
		border-radius: var(--radius-sm);
	}
	.split__item strong {
		color: var(--ink-strong);
	}
	.split__item--full {
		color: #056e61;
		background: var(--primary-tint);
	}
	.split__item--full strong {
		color: #056e61;
	}
	.split__item--start,
	.split__item--end {
		background: var(--surface-muted);
	}
	.split__item--end {
		box-shadow: inset 0 0 0 1px var(--brand-steel);
	}
</style>
