<script lang="ts">
	import { todayStr, addDaysStr, startOfMonthStr } from '$lib/date';

	let { from = $bindable(''), to = $bindable(''), onchange = () => {} } = $props<{
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

<div class="range-picker">
	<div class="presets">
		<button type="button" onclick={() => applyPreset('today')}>Today</button>
		<button type="button" onclick={() => applyPreset('7d')}>Last 7 days</button>
		<button type="button" onclick={() => applyPreset('30d')}>Last 30 days</button>
		<button type="button" onclick={() => applyPreset('month')}>This month</button>
	</div>
	<label>
		From:
		<input type="date" bind:value={from} onchange={() => onchange()} />
	</label>
	<label>
		To:
		<input type="date" bind:value={to} onchange={() => onchange()} />
	</label>
</div>

<style>
	.range-picker {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		margin: 0.5rem 0;
	}
	.presets {
		display: flex;
		gap: 0.25rem;
	}
	button {
		font-size: 0.8rem;
		padding: 0.25rem 0.5rem;
	}
</style>
