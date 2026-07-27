<script lang="ts">
	import { formatDate } from '$lib/date';

	// Generic day x entity grid. `days` is an array of "YYYY-MM-DD" strings.
	// `entities` is an array of { id, label }. `cellValue(entityId, day)` returns
	// either a status string ('present'|'morning_only'|'evening_only'|'absent')
	// or a number 0-100 (attendance %) when `mode === 'percent'`.
	let {
		days = [],
		entities = [],
		cellValue,
		mode = 'status'
	} = $props<{
		days: string[];
		entities: { id: string; label: string }[];
		cellValue: (entityId: string, day: string) => string | number | null;
		mode?: 'status' | 'percent';
	}>();

	function statusClass(v: string | number | null): string {
		if (mode === 'percent') {
			const pct = typeof v === 'number' ? v : 0;
			if (pct >= 90) return 'pct-high';
			if (pct >= 70) return 'pct-mid';
			if (pct >= 40) return 'pct-low';
			return 'pct-none';
		}
		switch (v) {
			case 'present':
				return 'st-present';
			case 'morning_only':
				return 'st-morning';
			case 'evening_only':
				return 'st-evening';
			default:
				return 'st-absent';
		}
	}

	function cellLabel(v: string | number | null): string {
		if (mode === 'percent') return typeof v === 'number' ? `${v}%` : '-';
		if (v === 'present') return 'P';
		if (v === 'morning_only') return 'M';
		if (v === 'evening_only') return 'E';
		return '-';
	}

	function accessibleCellLabel(entity: string, day: string, v: string | number | null): string {
		if (mode === 'percent') {
			return `${entity}, ${formatDate(day)}: ${typeof v === 'number' ? `${v}% attendance` : 'No attendance data'}`;
		}
		const status =
			v === 'present'
				? 'Present'
				: v === 'morning_only'
					? 'Morning only'
					: v === 'evening_only'
						? 'Evening only'
						: 'Absent';
		return `${entity}, ${formatDate(day)}: ${status}`;
	}
</script>

<div class="grid-wrap">
	<table
		class="calendar-grid"
		aria-label={mode === 'percent'
			? 'Attendance percentage calendar'
			: 'Attendance status calendar'}
	>
		<thead>
			<tr>
				<th class="day-col" scope="col">Day</th>
				{#each entities as e}
					<th scope="col" title={e.label}>{e.label}</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each days as day}
				<tr>
					<th class="day-col" scope="row">{formatDate(day)}</th>
					{#each entities as e}
						{@const v = cellValue(e.id, day)}
						<td class={statusClass(v)} aria-label={accessibleCellLabel(e.label, day, v)}
							>{cellLabel(v)}</td
						>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</div>

{#if mode === 'status'}
	<div class="legend" aria-label="Attendance status legend">
		<span><b class="legend__swatch st-present">P</b> Present</span>
		<span><b class="legend__swatch st-morning">M</b> Morning only</span>
		<span><b class="legend__swatch st-evening">E</b> Evening only</span>
		<span><b class="legend__swatch st-absent">-</b> Absent</span>
	</div>
{/if}

<style>
	.grid-wrap {
		overflow-x: auto;
		max-width: 100%;
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-lg);
	}

	.calendar-grid {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
	}

	.calendar-grid th,
	.calendar-grid td {
		min-width: 3.5rem;
		padding: var(--space-2);
		text-align: center;
		white-space: nowrap;
		border-right: 1px solid var(--brand-mist);
		border-bottom: 1px solid var(--brand-mist);
	}

	.calendar-grid thead th {
		position: sticky;
		top: 0;
		z-index: 2;
		color: var(--ink-muted);
		background: var(--surface-muted);
		font-weight: 700;
	}

	.day-col {
		text-align: left;
		position: sticky;
		left: 0;
		z-index: 1;
		min-width: 8rem;
		color: var(--ink-default);
		background: var(--brand-white);
	}

	thead .day-col {
		z-index: 3;
		background: var(--surface-muted);
	}

	.st-present {
		color: #056e61;
		background: var(--primary-tint);
	}

	.st-morning,
	.st-evening {
		color: var(--ink-default);
		background: var(--surface-muted);
	}

	.st-evening {
		box-shadow: inset 0 0 0 1px var(--brand-steel);
	}

	.st-absent {
		color: var(--ink-strong);
		background: var(--brand-white);
	}

	.pct-high {
		color: #056e61;
		background: var(--primary-tint);
	}

	.pct-mid {
		color: var(--ink-default);
		background: #dcecea;
	}

	.pct-low {
		color: var(--ink-default);
		background: var(--surface-muted);
	}

	.pct-none {
		color: var(--ink-strong);
		background: var(--brand-white);
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
		display: inline-grid;
		width: 1.5rem;
		height: 1.5rem;
		place-items: center;
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-sm);
	}
</style>
