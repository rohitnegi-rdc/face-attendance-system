<script lang="ts">
	// The pumps of an area or plant (attendanceRollup.ts pumpsToday): today's shift start and end
	// photo times, workers present today, and attendance over the chosen range. Each row opens the
	// pump page. Phone: the row stacks; wide screens line the columns up for comparison.
	import { resolve } from '$app/paths';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatTime } from '$lib/date';
	import type { PumpToday } from '$lib/server/attendanceRollup';

	let {
		pumps,
		rangeLabel,
		showPlant = false
	}: { pumps: PumpToday[]; rangeLabel: string; showPlant?: boolean } = $props();

	function shift(pump: PumpToday) {
		if (pump.startAt && pump.endAt) return { label: 'Full shift', tone: 'success' as const };
		if (pump.startAt) return { label: 'Waiting for end', tone: 'active' as const };
		if (pump.endAt) return { label: 'End only', tone: 'attention' as const };
		return { label: 'No photo today', tone: 'neutral' as const };
	}
</script>

<div class="pump-list" data-testid="pump-today-list">
	<div class="pump-list__head" aria-hidden="true">
		<span>Pump</span><span>Today</span><span>Present today</span><span>{rangeLabel}</span>
	</div>
	<ul>
		{#each pumps as pump (pump.id)}
			{@const today = shift(pump)}
			<li>
				<a
					class="pump-row"
					class:pump-row--fraud={pump.fraud > 0}
					href={resolve('/admin/pumps/[id]', { id: pump.id })}
					data-testid="pump-today-row"
				>
					<span class="pump-row__who">
						<strong>{pump.pumpCode}</strong>
						<small>{showPlant ? `${pump.plantName} · ` : ''}{pump.vendorName}</small>
					</span>
					<span class="pump-row__shift">
						<StatusBadge tone={today.tone} label={today.label} />
						{#if pump.startAt || pump.endAt}
							<small>
								{pump.startAt ? `Start ${formatTime(pump.startAt)}` : ''}{pump.startAt && pump.endAt
									? ' · '
									: ''}{pump.endAt ? `End ${formatTime(pump.endAt)}` : ''}
							</small>
						{/if}
						{#if pump.fraud}<span class="tag tag--fraud">{pump.fraud} fraud</span>{/if}
					</span>
					<span class="pump-row__num">
						<span class="pump-row__label">Present today</span>
						<span><strong>{pump.present}</strong> of {pump.total}</span>
					</span>
					<span class="pump-row__num">
						<span class="pump-row__label">{rangeLabel}</span>
						<span
							>{#if pump.rangePct === null}No records{:else}<strong>{pump.rangePct}%</strong>
								<small>({pump.rangePresent} of {pump.rangeTotal})</small>{/if}</span
						>
					</span>
				</a>
			</li>
		{:else}
			<li class="pump-list__empty">No pumps here yet.</li>
		{/each}
	</ul>
</div>

<style>
	.pump-list {
		overflow: hidden;
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li + li {
		border-top: 1px solid var(--brand-mist);
	}
	.pump-list__head {
		display: none;
	}
	.pump-list__empty {
		padding: var(--space-4);
		color: var(--ink-muted);
	}
	/* Phone: who and today on top, the two numbers side by side below. */
	.pump-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-3);
		color: var(--ink-default);
		text-decoration: none;
	}
	.pump-row:hover {
		background: var(--surface-subtle);
	}
	.pump-row--fraud {
		background: var(--alert-tint);
	}
	.pump-row__who,
	.pump-row__shift {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-2);
		grid-column: 1 / -1;
		min-width: 0;
	}
	.pump-row__who strong {
		color: var(--brand-teal);
	}
	small {
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}
	.pump-row__num {
		display: grid;
		font-size: var(--text-sm);
		font-variant-numeric: tabular-nums;
	}
	.pump-row__num strong {
		color: var(--ink-strong);
	}
	.pump-row__label {
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}
	.tag {
		padding: 0.1rem 0.5rem;
		font-size: var(--text-xs);
		font-weight: 700;
		border-radius: 999px;
	}
	.tag--fraud {
		color: var(--surface-raised);
		background: var(--alert);
	}
	@media (min-width: 48rem) {
		.pump-list__head,
		.pump-row {
			display: grid;
			grid-template-columns: minmax(10rem, 1.2fr) minmax(12rem, 1.6fr) minmax(7rem, 0.7fr) minmax(
					9rem,
					0.9fr
				);
			align-items: center;
			gap: var(--space-3);
			padding: var(--space-2) var(--space-4);
		}
		.pump-list__head {
			color: var(--ink-muted);
			font-size: var(--text-xs);
			font-weight: 700;
			background: var(--surface-muted);
		}
		.pump-row__who {
			display: grid;
			gap: 0;
		}
		.pump-row__who,
		.pump-row__shift {
			grid-column: auto;
		}
		.pump-row__label {
			display: none;
		}
	}
</style>
