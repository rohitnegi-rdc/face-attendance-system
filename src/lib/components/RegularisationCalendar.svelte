<script lang="ts">
	// The month calendar for regularisation, the same on the pump screen and the admin and
	// plant-manager pages. Green tick full shift, light red a start or end missing, dark red missed,
	// green R regularised, cross rejected, grey nothing to do. Tapping a day shows what happened
	// under the grid. The pump passes onpick/onmonth (buttons), the pages dayHref/monthHref (links).
	import Check from '@lucide/svelte/icons/check';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Hourglass from '@lucide/svelte/icons/hourglass';
	import X from '@lucide/svelte/icons/x';
	import type { Snippet } from 'svelte';
	import {
		DAY_DETAIL,
		NOTE_DETAIL,
		STATE_TEXT,
		WEEK_COLUMNS,
		addMonths,
		dayText,
		monthText
	} from '$lib/regularisationLabels';
	import type { CalendarDay, CalendarMonth } from '$lib/server/regularisationDays';

	type Words = { hi: string; en: string };

	let {
		calendar,
		selected,
		hindi = false,
		bilingual = false,
		onpick,
		onmonth,
		dayHref,
		monthHref,
		action
	}: {
		calendar: CalendarMonth;
		selected: string | null;
		hindi?: boolean;
		bilingual?: boolean;
		onpick?: (day: string) => void;
		onmonth?: (month: string) => void;
		dayHref?: (day: string) => string;
		monthHref?: (month: string) => string;
		action?: Snippet<[CalendarDay]>;
	} = $props();

	const word = (text: Words) => (hindi ? text.hi : text.en);
	const applyWord = $derived(hindi ? 'अर्ज़ी' : 'Apply');
	const LEGEND = ['full', 'partial', 'missed', 'waiting', 'regularised', 'rejected', 'none'] as const;

	const leading = $derived(
		(new Date(`${calendar.days[0].day}T00:00:00Z`).getUTCDay() + 6) % 7
	);
	const chosen = $derived(calendar.days.find((d) => d.day === selected) ?? null);
	const previous = $derived(addMonths(calendar.month, -1));
	const next = $derived(addMonths(calendar.month, 1));

	const detail = (d: CalendarDay): Words =>
		d.state === 'none'
			? d.note
				? NOTE_DETAIL[d.note]
				: STATE_TEXT.none
			: DAY_DETAIL[d.state];

	// Names come labelled in English from the server; the pump reading Hindi sees them in Hindi.
	const person = (name: string) =>
		hindi
			? name.replace(' (start only)', ' (सिर्फ़ शुरू)').replace(' (end only)', ' (सिर्फ़ अंत)')
			: name;

	const number = (d: CalendarDay) => Number(d.day.slice(8));
	const cellLabel = (d: CalendarDay) =>
		`${word(dayText(d.day))}: ${d.state === 'none' ? word(detail(d)) : word(STATE_TEXT[d.state])}`;
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- dayHref and monthHref are query strings on the current page -->
{#snippet mark(d: CalendarDay)}
	<span class="num">{number(d)}</span>
	{#if d.state === 'full'}
		<Check size={18} strokeWidth={3} aria-hidden="true" />
	{:else if d.state === 'regularised'}
		<span class="letter" aria-hidden="true">R</span>
	{:else if d.state === 'rejected'}
		<X size={18} strokeWidth={3} aria-hidden="true" />
	{:else if d.state === 'waiting'}
		<Hourglass size={15} strokeWidth={2.5} aria-hidden="true" />
	{:else if d.state === 'partial' || d.state === 'missed'}
		<span class="apply" aria-hidden="true">{applyWord}</span>
	{/if}
{/snippet}

{#snippet swatch(state: (typeof LEGEND)[number])}
	<span class="swatch cell--{state}" aria-hidden="true">
		{#if state === 'full'}
			<Check size={13} strokeWidth={3} />
		{:else if state === 'regularised'}
			R
		{:else if state === 'rejected'}
			<X size={13} strokeWidth={3} />
		{:else if state === 'waiting'}
			<Hourglass size={12} strokeWidth={2.5} />
		{/if}
	</span>
{/snippet}

{#snippet step(target: string, enabled: boolean, testid: string, label: string, Icon: typeof Check)}
	{#if !enabled}
		<span class="nav nav--off" aria-hidden="true"><Icon size={22} /></span>
	{:else if monthHref}
		<a class="nav" href={monthHref(target)} aria-label={label} data-testid={testid} data-sveltekit-noscroll
			><Icon size={22} /></a
		>
	{:else}
		<button class="nav" type="button" aria-label={label} data-testid={testid} onclick={() => onmonth?.(target)}
			><Icon size={22} /></button
		>
	{/if}
{/snippet}

<div class="cal" data-testid="reg-calendar">
	<div class="head">
		{@render step(
			previous,
			calendar.month > calendar.minMonth,
			'reg-cal-prev',
			hindi ? 'पिछला महीना' : 'Previous month',
			ChevronLeft
		)}
		<strong class="title" data-testid="reg-cal-month">{word(monthText(calendar.month))}</strong>
		{@render step(
			next,
			calendar.month < calendar.maxMonth,
			'reg-cal-next',
			hindi ? 'अगला महीना' : 'Next month',
			ChevronRight
		)}
	</div>

	<ul class="legend">
		{#each LEGEND as state (state)}
			<li>{@render swatch(state)}{word(STATE_TEXT[state])}</li>
		{/each}
	</ul>

	<div class="grid">
		{#each hindi ? WEEK_COLUMNS.hi : WEEK_COLUMNS.en as name (name)}
			<span class="week" aria-hidden="true">{name}</span>
		{/each}
		{#each { length: leading }, i (i)}
			<span></span>
		{/each}
		{#each calendar.days as d (d.day)}
			{#if dayHref}
				<a
					class="cell cell--{d.state}"
					class:cell--on={d.day === selected}
					class:cell--today={d.note === 'today'}
					href={dayHref(d.day)}
					aria-label={cellLabel(d)}
					aria-current={d.day === selected ? 'date' : undefined}
					data-testid="reg-cal-day"
					data-day={d.day}
					data-state={d.state}
					data-sveltekit-noscroll>{@render mark(d)}</a
				>
			{:else}
				<button
					class="cell cell--{d.state}"
					class:cell--on={d.day === selected}
					class:cell--today={d.note === 'today'}
					type="button"
					aria-label={cellLabel(d)}
					aria-pressed={d.day === selected}
					data-testid="reg-cal-day"
					data-day={d.day}
					data-state={d.state}
					onclick={() => onpick?.(d.day)}>{@render mark(d)}</button
				>
			{/if}
		{/each}
	</div>

	{#if chosen}
		<div class="panel" data-testid="reg-cal-panel" aria-live="polite">
			<strong class="panel__day">{word(dayText(chosen.day))}</strong>
			<p class="panel__what">
				{word(detail(chosen))}
				{#if bilingual}<small>{hindi ? detail(chosen).en : detail(chosen).hi}</small>{/if}
			</p>
			{#if chosen.counted.length}
				<p class="panel__names">{chosen.counted.map(person).join(', ')}</p>
			{/if}
			{#if chosen.request?.decidedAt}
				<p class="panel__who">
					{[
						chosen.request.status === 'rejected'
							? hindi
								? 'नामंज़ूर'
								: 'Rejected'
							: hindi
								? 'मंज़ूर'
								: 'Approved',
						chosen.request.decidedByName,
						chosen.request.decidedAt
					]
						.filter(Boolean)
						.join(' · ')}
				</p>
			{/if}
			{#if chosen.request?.decisionReason}
				<p class="panel__reason">{chosen.request.decisionReason}</p>
			{/if}
			{@render action?.(chosen)}
		</div>
	{/if}
</div>

<style>
	.cal {
		display: grid;
		gap: var(--space-3);
		width: 100%;
		max-width: 30rem;
		margin-inline: auto;
		min-width: 0;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.title {
		font-size: var(--text-lg);
	}
	.nav {
		display: grid;
		place-items: center;
		width: 3rem;
		height: 3rem;
		color: var(--ink-strong);
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
		cursor: pointer;
	}
	.nav--off {
		visibility: hidden;
	}
	.legend {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-3);
		font-size: var(--text-sm);
	}
	.legend li {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
	}
	.swatch {
		display: inline-grid;
		place-items: center;
		width: 1.125rem;
		height: 1.125rem;
		font-size: 0.75rem;
		font-weight: 800;
		border-radius: 4px;
	}
	.swatch.cell--partial {
		border: 1px solid #dc2626;
	}
	.swatch.cell--rejected {
		border: 1px solid #b91c1c;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: 2px;
	}
	.week {
		padding-block: var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-sm);
		font-weight: 600;
		text-align: center;
	}
	.cell {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1px;
		min-width: 0;
		min-height: 3.5rem;
		padding: 2px 0;
		font: inherit;
		text-decoration: none;
		border: 2px solid transparent;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}
	.num {
		font-size: 0.9375rem;
		font-weight: 700;
		line-height: 1.1;
	}
	.apply {
		font-size: 0.75rem;
		font-weight: 700;
		line-height: 1.1;
	}
	.letter {
		font-size: 0.9375rem;
		font-weight: 800;
		line-height: 1.1;
	}
	.cell--full,
	.cell--regularised {
		color: #14532d;
		background: #bbf7d0;
	}
	.cell--partial {
		color: #991b1b;
		background: #fee2e2;
		border-color: #dc2626;
	}
	.cell--missed {
		color: #fff;
		background: #b91c1c;
	}
	.cell--rejected {
		color: #b91c1c;
		background: #fff;
		border-color: #b91c1c;
	}
	.cell--waiting {
		color: #78350f;
		background: #fef3c7;
	}
	.cell--none {
		color: #37474f;
		background: #eceff1;
	}
	.cell--today {
		border-color: #37474f;
	}
	.cell--on {
		outline: 3px solid var(--brand-teal);
		outline-offset: 1px;
		position: relative;
		z-index: 1;
	}
	.panel {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-3);
		background: var(--surface-subtle);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
		min-width: 0;
	}
	.panel p {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.panel__what small {
		display: block;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.panel__names,
	.panel__who {
		font-size: var(--text-sm);
	}
	.panel__reason {
		font-weight: 600;
	}
</style>
