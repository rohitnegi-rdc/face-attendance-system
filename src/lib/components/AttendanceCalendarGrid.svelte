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
</script>

<div class="grid-wrap">
	<table class="calendar-grid">
		<thead>
			<tr>
				<th class="day-col">Day</th>
				{#each entities as e}
					<th title={e.label}>{e.label}</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each days as day}
				<tr>
					<td class="day-col">{formatDate(day)}</td>
					{#each entities as e}
						{@const v = cellValue(e.id, day)}
						<td class={statusClass(v)} title={String(v)}>{cellLabel(v)}</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.grid-wrap {
		overflow-x: auto;
		max-width: 100%;
	}
	.calendar-grid {
		border-collapse: collapse;
		font-size: 0.8rem;
	}
	.calendar-grid th,
	.calendar-grid td {
		border: 1px solid #ddd;
		padding: 0.2rem 0.4rem;
		text-align: center;
		white-space: nowrap;
	}
	.day-col {
		text-align: left;
		position: sticky;
		left: 0;
		background: white;
	}
	.st-present {
		background: #d1fadf;
	}
	.st-morning,
	.st-evening {
		background: #fef3c7;
	}
	.st-absent {
		background: #fee2e2;
	}
	.pct-high {
		background: #d1fadf;
	}
	.pct-mid {
		background: #fef3c7;
	}
	.pct-low {
		background: #fed7aa;
	}
	.pct-none {
		background: #fee2e2;
	}
</style>
