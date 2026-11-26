<script lang="ts">
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import FacePeek from '$lib/components/FacePeek.svelte';
	import { formatDate, formatDayLabel } from '$lib/date';

	// Generic entity x day grid. `days` is an array of "YYYY-MM-DD" strings, rendered as
	// horizontally-scrollable columns. `entities` is an array of { id, label, faceUrl? }, rendered
	// as rows; worker rows pass faceUrl so the face shows beside the name. `cellValue(entityId, day)` returns either a status string
	// ('present'|'morning_only'|'evening_only'|'absent') or a number 0-100 (attendance %)
	// when `mode === 'percent'` ('open' there: a shift still on, shown as "Shift on"), or a headcount when `mode === 'count'` (gangs),
	// or { full, startOnly, endOnly, open? } when `mode === 'split'` (workers by shift, the same three
	// counts as ShiftSplit and the 9 am email; a row may carry `total`, the same three over the range,
	// shown under its label). `heldCell` marks a
	// day waiting for or refused a location approval (amber, left out of totals); `href` links a row.
	let {
		days = [],
		entities = [],
		cellValue,
		mode = 'status',
		entityLabel = 'Entity',
		heldCell
	} = $props<{
		days: string[];
		entities: {
			id: string;
			label: string;
			faceUrl?: string;
			href?: string;
			total?: { full: number; startOnly: number; endOnly: number };
		}[];
		cellValue: (entityId: string, day: string) => string | number | Split | null;
		mode?: 'status' | 'percent' | 'count' | 'split';
		entityLabel?: string;
		heldCell?: (entityId: string, day: string) => boolean;
	}>();
	type Split = { full: number; startOnly: number; endOnly: number; open?: boolean };
	const asSplit = (v: unknown): Split | null =>
		v && typeof v === 'object' && 'full' in v ? (v as Split) : null;
	let scroller: HTMLDivElement;
	const orderedDays = $derived([...days].sort((a, b) => b.localeCompare(a)));

	function scrollDates(direction: -1 | 1) {
		scroller?.scrollBy({
			left: direction * Math.max(scroller.clientWidth * 0.75, 320),
			behavior: 'smooth'
		});
	}

	function statusClass(v: string | number | Split | null): string {
		if (mode === 'split') {
			const split = asSplit(v);
			if (!split) return 'sc-cell sc-cell--empty';
			// Tinted only when the day is complete: everyone counted had a start and an end.
			const complete = split.full > 0 && !split.startOnly && !split.endOnly && !split.open;
			return complete ? 'sc-cell sc-cell--complete' : 'sc-cell';
		}
		if (mode === 'count') return typeof v === 'number' ? 'pct-mid' : 'pct-none';
		if (mode === 'percent') {
			if (v === 'open') return 'pct-open';
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

	function cellLabel(v: string | number | Split | null): string {
		if (mode === 'count') return typeof v === 'number' ? String(v) : '-';
		if (mode === 'percent' && v === 'open') return 'Shift on';
		if (mode === 'percent') return typeof v === 'number' ? `${v}%` : '-';
		if (v === 'present') return 'P';
		if (v === 'morning_only') return 'M';
		if (v === 'evening_only') return 'E';
		return '-';
	}

	function accessibleCellLabel(
		entity: string,
		day: string,
		v: string | number | Split | null
	): string {
		if (mode === 'split') {
			const split = asSplit(v);
			if (!split) return `${entity}, ${formatDate(day)}: no attendance`;
			return `${entity}, ${formatDate(day)}: ${split.full} full shift, ${split.startOnly} start only, ${split.endOnly} end only${split.open ? ', shift still on' : ''}`;
		}
		if (mode === 'count')
			return `${entity}, ${formatDate(day)}: ${typeof v === 'number' ? `${v} people` : 'No shift'}`;
		if (mode === 'percent' && v === 'open') return `${entity}, ${formatDate(day)}: shift still on`;
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
		<button
			class="icon-button"
			type="button"
			aria-label="Show newer dates"
			title="Newer dates"
			onclick={() => scrollDates(-1)}><ChevronLeft size={18} /></button
		>
		<button
			class="icon-button"
			type="button"
			aria-label="Show older dates"
			title="Older dates"
			onclick={() => scrollDates(1)}><ChevronRight size={18} /></button
		>
	</div>
</div>
<div class="grid-wrap" bind:this={scroller} role="region" aria-label="Scrollable attendance dates">
	<table
		class:calendar-grid--split={mode === 'split'}
		class="calendar-grid"
		aria-label={mode === 'percent'
			? 'Attendance percentage calendar'
			: mode === 'count'
				? 'Headcount calendar'
				: mode === 'split'
					? 'Workers by shift calendar'
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
					<th class="entity-col" scope="row" title={e.label}>
						{#if e.faceUrl}<span class="worker-tag entity-worker"
								><FacePeek url={e.faceUrl} label={e.label} /><span class="entity-name"
									>{e.label}</span
								></span
							>{:else if e.href}<a href={e.href}>{e.label}</a>{:else}{e.label}{/if}
						{#if mode === 'split' && e.total}<span class="sc-total" data-testid="pump-total"
								><b class:sc-zero={!e.total.full}>{e.total.full}</b> full<span class="sc-sep"
									>·</span
								><b class:sc-zero={!e.total.startOnly}>{e.total.startOnly}</b> start<span
									class="sc-sep">·</span
								><b class:sc-zero={!e.total.endOnly}>{e.total.endOnly}</b> end</span
							>{/if}
					</th>
					{#each orderedDays as day}
						{@const v = cellValue(e.id, day)}
						{@const split = mode === 'split' ? asSplit(v) : null}
						<td
							class={statusClass(v)}
							class:held={heldCell?.(e.id, day)}
							aria-label={accessibleCellLabel(e.label, day, v)}
							>{#if split}<span class="sc-part" class:sc-zero={!split.full}
									><b>{split.full}</b> full</span
								><span class="sc-part" class:sc-zero={!split.startOnly}
									><b>{split.startOnly}</b> start only</span
								><span class="sc-part" class:sc-zero={!split.endOnly}
									><b>{split.endOnly}</b> end only</span
								>{#if split.open}<span class="sc-on">Shift on</span
									>{/if}{:else if mode === 'split'}<span class="sc-none">–</span>{:else}{cellLabel(
									v
								)}{/if}</td
						>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</div>

{#if mode === 'split'}
	<p class="sc-legend">
		Full: start and end photo. Start only / end only: someone missed half. A 0 is red.
		<b>Shift on</b>: the end photo is still to come. A tinted day: everyone had a full shift. Under
		each pump: its total for these dates.
	</p>
{/if}
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
	.calendar-toolbar > div {
		display: flex;
		gap: var(--space-1);
	}
	.calendar-toolbar .icon-button {
		width: 2.25rem;
		height: 2.25rem;
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
	}
	.grid-wrap {
		position: relative;
		isolation: isolate;
		overflow: auto;
		max-width: 100%;
		max-height: min(36rem, 70vh);
		/* Lets the day columns size themselves to a week of the visible width (see .day-head). */
		container-type: inline-size;
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

	/* Seven day columns fill the visible width next to the name column; older days scroll in from
	   the right. On a narrow screen a column never shrinks below 4.5rem, so fewer days show. */
	.day-head,
	.calendar-grid td {
		width: max(4.5rem, calc((100cqi - clamp(10rem, 22vw, 15rem)) / 7));
		min-width: max(4.5rem, calc((100cqi - clamp(10rem, 22vw, 15rem)) / 7));
	}
	.day-head {
		scroll-snap-align: start;
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

	.entity-worker {
		max-width: 100%;
	}

	.entity-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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

	/* A shift still on: its end can come, so no percent yet. */
	.pct-open {
		color: var(--brand-teal);
		font-weight: 700;
		background: var(--brand-white);
	}

	/* Workers by shift: the full-shift count leads; the missing halves follow only when there are
	   any, so a normal day is one number and an exception reads at a glance. */
	.calendar-grid--split .entity-col {
		text-align: left;
	}
	.calendar-grid--split tbody .entity-col {
		vertical-align: top;
	}
	.calendar-grid--split tbody .entity-col {
		font-weight: 700;
		color: var(--ink-strong);
	}
	.calendar-grid--split td,
	.calendar-grid--split .day-head {
		min-width: max(5.25rem, calc((100cqi - clamp(10rem, 22vw, 15rem)) / 7));
	}
	.calendar-grid--split td.sc-cell {
		vertical-align: top;
		text-align: center;
		line-height: 1.3;
		color: var(--ink-default);
		background: var(--brand-white);
	}
	.calendar-grid--split td.sc-cell--complete {
		background: var(--primary-tint);
	}
	.calendar-grid--split td.sc-cell--empty {
		vertical-align: middle;
		text-align: center;
	}
	.sc-none {
		color: var(--brand-mist);
	}
	.sc-part,
	.sc-on {
		display: block;
		white-space: nowrap;
	}
	.sc-part {
		color: var(--ink-strong);
	}
	.sc-part b {
		margin-right: 0.15em;
	}
	.sc-part.sc-zero,
	.sc-part.sc-zero b {
		color: var(--alert);
	}
	.sc-on {
		margin-top: var(--space-1);
		color: var(--primary-pressed);
		font-weight: 700;
	}
	.sc-total {
		display: block;
		margin-top: var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 400;
		white-space: normal;
	}
	.sc-total b {
		color: var(--ink-strong);
	}
	.sc-total b.sc-zero {
		color: var(--alert);
	}
	.sc-sep {
		margin: 0 0.35em;
		color: var(--brand-mist);
	}
	.sc-legend {
		max-width: 72ch;
		margin: var(--space-2) 0 0;
		color: var(--ink-muted);
		font-size: var(--text-xs);
		line-height: 1.5;
	}

	.calendar-grid td.held {
		color: var(--ink-strong);
		background: #ffe3a3;
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
		.entity-col {
			width: 9rem;
			min-width: 9rem;
			max-width: 9rem;
		}
		.day-head,
		.calendar-grid td {
			min-width: 4.25rem;
		}
	}
</style>
