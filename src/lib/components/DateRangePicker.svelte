<script lang="ts">
	import { todayStr, addDaysStr, startOfMonthStr } from '$lib/date';
	import CalendarDays from '@lucide/svelte/icons/calendar-days';

	let {
		from = $bindable(''),
		to = $bindable(''),
		onchange = () => {}
	} = $props<{
		from?: string;
		to?: string;
		onchange?: () => void;
	}>();

	function applyPreset(preset: string) {
		const today = todayStr();
		if (preset === 'today') {
			from = today;
			to = today;
		} else if (preset === '7d') {
			from = addDaysStr(today, -6);
			to = today;
		} else if (preset === '30d') {
			from = addDaysStr(today, -29);
			to = today;
		} else if (preset === 'month') {
			from = startOfMonthStr(today);
			to = today;
		}
		onchange();
	}
</script>

<div class="range-picker" aria-label="Date range">
	<div class="range-picker__title">
		<CalendarDays size={18} aria-hidden="true" />
		<strong>Date range</strong>
	</div>
	<div class="presets" aria-label="Date range presets">
		<button class="preset" type="button" onclick={() => applyPreset('today')}>Today</button>
		<button class="preset" type="button" onclick={() => applyPreset('7d')}>Last 7 days</button>
		<button class="preset" type="button" onclick={() => applyPreset('30d')}>Last 30 days</button>
		<button class="preset" type="button" onclick={() => applyPreset('month')}>This month</button>
	</div>
	<label class="field">
		From
		<input type="date" bind:value={from} onchange={() => onchange()} />
	</label>
	<label class="field">
		To
		<input type="date" bind:value={to} onchange={() => onchange()} />
	</label>
</div>

<style>
	.range-picker {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		align-items: flex-end;
		padding: var(--space-3);
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-lg);
	}

	.range-picker__title {
		display: flex;
		min-height: 2.75rem;
		align-items: center;
		gap: var(--space-2);
		color: var(--ink-strong);
	}

	.presets {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}

	.preset {
		min-height: 2.75rem;
		padding: var(--space-2) var(--space-3);
		color: var(--ink-default);
		background: var(--surface-subtle);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
		font-size: var(--text-sm);
		font-weight: 600;
		cursor: pointer;
	}

	.preset:hover {
		background: var(--primary-tint);
		border-color: var(--brand-teal);
	}

	.field {
		min-width: 9rem;
	}

	@media (max-width: 40rem) {
		.range-picker,
		.range-picker__title,
		.presets,
		.field {
			width: 100%;
		}

		.presets {
			display: grid;
			grid-template-columns: 1fr 1fr;
		}
	}
</style>
