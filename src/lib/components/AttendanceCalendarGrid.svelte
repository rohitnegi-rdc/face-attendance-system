<script lang="ts">
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { formatDate, formatDayLabel } from '$lib/date';

	// Generic entity x day grid. `days` is an array of "YYYY-MM-DD" strings, rendered as
	// horizontally-scrollable columns. `entities` is an array of { id, label }, rendered as
	// rows. `cellValue(entityId, day)` returns either a status string
	// ('present'|'morning_only'|'evening_only'|'absent') or a number 0-100 (attendance %)
	// when `mode === 'percent'`.
	let {
		days = [],
		entities = [],
		cellValue,
		mode = 'status',
		entityLabel = 'Entity'
	} = $props<{
		days: string[];
		entities: { id: string; label: string }[];
		cellValue: (entityId: string, day: string) => string | number | null;
		mode?: 'status' | 'percent';
		entityLabel?: string;
	}>();
	let scroller: HTMLDivElement;
	const orderedDays = $derived([...days].sort((a, b) => b.localeCompare(a)));

	function scrollDates(direction: -1 | 1) {
		scroller?.scrollBy({
			left: direction * Math.max(scroller.clientWidth * 0.75, 320),
			behavior: 'smooth'
		});
	}

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
					? 'Start only'
					: v === 'evening_only'
						? 'End only'
						: 'Absent';
		return `${entity}, ${formatDate(day)}: ${status}`;
	}
</script>

<div class="calendar-toolbar" aria-label="Date navigation">
	<span>Newest dates first</span>
	<div>
		<button class="icon-button" type="button" aria-label="Show newer dates" title="Newer dates" onclick={() => scrollDates(-1)}><ChevronLeft size={18} /></button>
		<button class="icon-button" type="button" aria-label="Show older dates" title="Older dates" onclick={() => scrollDates(1)}><ChevronRight size={18} /></button>
	</div>
</div>
<div class="grid-wrap" bind:this={scroller} role="region" aria-label="Scrollable attendance dates">
	<table
		class="calendar-grid"
		aria-label={mode === 'percent'
			? 'Attendance percentage calendar'
			: 'Attendance status calendar'}
	>
		<thead>
			<tr>
				<th class="entity-col" scope="col">{entityLabel}</th>
				{#each orderedDays as day}
					{@const label = formatDayLabel(day)}
					<th class="day-head" scope="col" title={formatDate(day)}>
						<span class="day-head__weekday">{label.weekday}</span>
						<span class="day-head__date">{label.date}</span>
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each entities as e}
				<tr>
					<th class="entity-col" scope="row" title={e.label}>{e.label}</th>
					{#each orderedDays as day}
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
		<span><b class="legend__swatch st-morning">M</b> Start only</span>
		<span><b class="legend__swatch st-evening">E</b> End only</span>
		<span><b class="legend__swatch st-absent">-</b> Absent</span>
	</div>
{/if}

<style>
	.calendar-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		margin-bottom: var(--space-2);
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}
	.calendar-toolbar > div { display: flex; gap: var(--space-1); }
	.calendar-toolbar .icon-button {
		width: 2.25rem;
		height: 2.25rem;
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
	}
	.grid-wrap {
		position: relative;
		isolation: isolate;
		overflow-x: auto;
		overflow-y: visible;
		max-width: 100%;
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-lg);
		overscroll-behavior-inline: contain;
		scroll-behavior: smooth;
		scrollbar-width: thin;
		scrollbar-color: var(--brand-mist) var(--surface-muted);
	}
	.grid-wrap::-webkit-scrollbar {
		width: 10px;
		height: 10px;
	}
	.grid-wrap::-webkit-scrollbar-track {
		background: var(--surface-muted);
		border-radius: var(--radius-sm);
	}
	.grid-wrap::-webkit-scrollbar-thumb {
		background: var(--brand-mist);
		border-radius: var(--radius-sm);
		border: 2px solid var(--surface-muted);
	}
	.grid-wrap::-webkit-scrollbar-thumb:hover {
		background: var(--brand-teal);
	}

	.calendar-grid {
		width: max-content;
		min-width: 100%;
		border-collapse: collapse;
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
	}

	.calendar-grid th,
	.calendar-grid td {
		padding: var(--space-2);
		text-align: center;
		white-space: nowrap;
		border-right: 1px solid var(--brand-mist);
		border-bottom: 1px solid var(--brand-mist);
	}

	.day-head {
		min-width: 4.5rem;
		scroll-snap-align: start;
	}
	.calendar-grid td {
		min-width: 4.5rem;
	}

	.day-head__weekday {
		display: block;
		color: var(--ink-muted);
	}
	.day-head__date {
		display: block;
		font-weight: 700;
	}

	.calendar-grid thead th {
		position: sticky;
		top: 0;
		z-index: 2;
		color: var(--ink-muted);
		background: var(--surface-muted);
		font-weight: 700;
	}

	.entity-col {
		text-align: left;
		position: sticky;
		left: 0;
		z-index: 3;
		width: clamp(10rem, 22vw, 15rem);
		min-width: clamp(10rem, 22vw, 15rem);
		max-width: clamp(10rem, 22vw, 15rem);
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--ink-default);
		background: var(--brand-white);
		box-shadow: 1px 0 0 var(--brand-mist);
	}

	.calendar-grid thead .entity-col {
		z-index: 5;
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
	@media (max-width: 47.99rem) {
		.entity-col { width: 9rem; min-width: 9rem; max-width: 9rem; }
		.day-head, .calendar-grid td { min-width: 4.25rem; }
	}
</style>
