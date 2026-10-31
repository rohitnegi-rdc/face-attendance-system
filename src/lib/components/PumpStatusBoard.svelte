<script lang="ts">
	// Pump status, the same page for the admin, plant managers and monitors (src/lib/server/pumpStatus.ts):
	// each pump's Active / Idle / Inactive for today and tomorrow, changed right in the row, and how
	// many days it was each over the chosen week, month or year. On a phone each row is a card.
	import { enhance } from '$app/forms';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import {
		PUMP_WORK_STATUSES,
		PUMP_WORK_STATUS_LABELS,
		type PumpWorkStatus
	} from '$lib/pumpWorkStatus';

	import type { loadPumpStatus } from '$lib/server/pumpStatus';

	type SaveResult = {
		success?: boolean;
		message?: string;
		pumpCode?: string;
		day?: string;
		status?: string;
		site?: string | null;
		siteChanged?: boolean;
	} | null;
	let { data, form }: { data: Awaited<ReturnType<typeof loadPumpStatus>>; form: SaveResult } =
		$props();

	// "Sat, 1 Nov" (or "Sat, 1 Nov 2026" with the year) for a YYYY-MM-DD day.
	function day(value: string, withYear = false) {
		return new Intl.DateTimeFormat('en-GB', {
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			...(withYear ? { year: 'numeric' } : {}),
			timeZone: 'UTC'
		})
			.format(new Date(`${value}T00:00:00Z`))
			.replace(/^(\w+) /, '$1, ')
			.replace('Sept', 'Sep');
	}
	const periodLabel = $derived.by(() => {
		const { from, to } = data.range;
		if (data.period === 'year') return from.slice(0, 4);
		if (data.period === 'month')
			return new Intl.DateTimeFormat('en-GB', {
				month: 'long',
				year: 'numeric',
				timeZone: 'UTC'
			}).format(new Date(`${from}T00:00:00Z`));
		return `${day(from)} – ${day(to, true)}`;
	});
	const counted = $derived(
		data.range.countTo >= data.range.from
			? Math.round((Date.parse(data.range.countTo) - Date.parse(data.range.from)) / 86_400_000 + 1)
			: 0
	);
	// Every day of a week or month, for the day-by-day strip (a year shows the counts only).
	const showStrip = $derived(data.period !== 'year');
	const periodDays = $derived.by(() => {
		const days: string[] = [];
		for (let t = Date.parse(data.range.from); t <= Date.parse(data.range.to); t += 86_400_000)
			days.push(new Date(t).toISOString().slice(0, 10));
		return days;
	});
	const fullLength = $derived(
		Math.round((Date.parse(data.range.to) - Date.parse(data.range.from)) / 86_400_000 + 1)
	);

	// Links keep the period, search, filter and page except what they change.
	function link(changes: Record<string, string | number | null>) {
		const params = new URLSearchParams();
		const current: Record<string, string | number | null> = {
			period: data.period,
			at: data.at === data.today ? null : data.at,
			q: data.filters.q || null,
			status: data.filters.status || null,
			page: null,
			...changes
		};
		for (const [key, value] of Object.entries(current))
			if (value !== null && value !== '' && !(key === 'page' && value === 1))
				params.set(key, String(value));
		const search = params.toString();
		return search ? `?${search}` : '?';
	}
	const saveAction = $derived(`${link({ page: data.pagination.page })}&/setStatus`);
	const saved = $derived(
		!form?.success || !form.day
			? ''
			: form.siteChanged
				? form.site
					? `${form.pumpCode} is at ${form.site} from ${day(form.day)}.`
					: `${form.pumpCode} has no site from ${day(form.day)}.`
				: `${form.pumpCode} is ${PUMP_WORK_STATUS_LABELS[form.status as PumpWorkStatus]} from ${day(form.day)}.`
	);
</script>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<h1>Pump status</h1>
			<p>
				Every pump starts Inactive. Set the pumps that work Active or Idle for today or tomorrow; a
				status stays until it is changed. Only Active and Idle pumps are in the 9 am attendance
				email.
			</p>
		</div>
	</header>

	<nav class="period" aria-label="Period">
		<div class="period-tabs">
			{#each [['week', 'Week'], ['month', 'Month'], ['year', 'Year']] as [value, label] (value)}
				<a
					href={link({ period: value, at: null })}
					aria-current={data.period === value ? 'page' : undefined}
					data-testid="status-period-{value}">{label}</a
				>
			{/each}
		</div>
		<div class="period-step">
			<a
				class="step"
				href={link({ at: data.range.previous })}
				aria-label="Previous {data.period}"
				data-testid="status-previous"><ChevronLeft size={18} /></a
			>
			<strong data-testid="status-period-label">{periodLabel}</strong>
			{#if data.range.hasNext}<a
					class="step"
					href={link({ at: data.range.next })}
					aria-label="Next {data.period}"><ChevronRight size={18} /></a
				>{:else}<span class="step step--off" aria-hidden="true"><ChevronRight size={18} /></span
				>{/if}
		</div>
	</nav>

	<form class="filter-bar status-filter" method="GET" role="search">
		<input type="hidden" name="period" value={data.period} />
		{#if data.at !== data.today}<input type="hidden" name="at" value={data.at} />{/if}
		<label class="field"
			><span>Search</span><input
				name="q"
				type="search"
				value={data.filters.q}
				placeholder="Pump, plant or area"
				autocomplete="off"
				data-testid="status-search"
			/></label
		><label class="field"
			><span>Today</span><select
				name="status"
				value={data.filters.status}
				data-testid="status-filter"
				><option value="">All</option>{#each PUMP_WORK_STATUSES as value (value)}<option {value}
						>{PUMP_WORK_STATUS_LABELS[value]}</option
					>{/each}</select
			></label
		>
		<div class="filter-actions">
			<button class="button button--primary" type="submit">Show</button>
		</div>
	</form>

	<p class="today-line" data-testid="status-today-counts">
		Today, {day(data.today)}:
		{#each PUMP_WORK_STATUSES as value (value)}
			<a
				class="count count--{value}"
				href={link({ status: data.filters.status === value ? null : value })}
				aria-current={data.filters.status === value ? 'true' : undefined}
				><strong>{data.todayCounts[value]}</strong> {PUMP_WORK_STATUS_LABELS[value]}</a
			>
		{/each}
	</p>

	{#if form?.message}
		<p class="alert alert--error" role="alert">{form.message}</p>
	{:else if saved}
		<p class="alert" role="status" data-testid="status-saved">{saved}</p>
	{/if}

	{#if data.pumps.length}
		<div class="table-head-line">
			<p data-testid="status-days-line">
				Days in <strong>{periodLabel}</strong>{counted < fullLength
					? `, counted up to today (${counted} of ${fullLength})`
					: ''}.
			</p>
			{#if showStrip}<p class="legend" aria-hidden="true">
					{#each PUMP_WORK_STATUSES as value (value)}<span
							><i class="cell cell--{value}"></i>{PUMP_WORK_STATUS_LABELS[value]}</span
						>{/each}<span><i class="cell cell--none"></i>Not added yet or still to come</span>
				</p>{/if}
		</div>
		<div class="table-wrap">
			<table class="data-table status-table" data-testid="pump-status-table">
				<thead>
					<tr>
						<th>Pump</th>
						<th>Today <small>{day(data.today)}</small></th>
						<th>Tomorrow <small>{day(data.tomorrow)}</small></th>
						{#if showStrip}<th
								>Day by day <small>{day(data.range.from)} to {day(data.range.to)}</small></th
							>{/if}
						<th class="num">Active days</th>
						<th class="num">Idle days</th>
						<th class="num">Inactive days</th>
					</tr>
				</thead>
				<tbody>
					{#each data.pumps as pump (pump.id)}
						<tr class="row--{pump.today_status}" data-testid="status-row">
							<td class="pump-cell">
								<strong>{pump.pump_code}</strong>
								<small>{pump.plant_name} · {pump.area_name}</small>
							</td>
							{#each [['today', data.today, pump.today_status, pump.today_site], ['tomorrow', data.tomorrow, pump.tomorrow_status, pump.tomorrow_site]] as [key, value, current, site] (key)}
								<td class="pick" data-label={key === 'today' ? 'Today' : 'Tomorrow'}>
									<form
										method="POST"
										action={saveAction}
										use:enhance={() =>
											async ({ update }) =>
												update({ reset: false, invalidateAll: true })}
									>
										<input type="hidden" name="pump" value={pump.id} />
										<input type="hidden" name="day" {value} />
										<select
											name="status"
											class="pick-status pick-status--{current}"
											value={current}
											aria-label="{pump.pump_code} {key}"
											data-testid="status-{key}"
											onchange={(e) => e.currentTarget.form?.requestSubmit()}
											>{#each PUMP_WORK_STATUSES as option (option)}<option value={option}
													>{PUMP_WORK_STATUS_LABELS[option]}</option
												>{/each}</select
										>
										<input
											name="site"
											type="text"
											class="pick-site"
											value={site ?? ''}
											maxlength="80"
											placeholder="Site name"
											autocomplete="off"
											aria-label="{pump.pump_code} site {key}"
											data-testid="site-{key}"
											onchange={(e) => e.currentTarget.form?.requestSubmit()}
										/>
									</form>
									{#if key === 'today'}<small class="since"
											>{pump.today_since
												? `Since ${day(pump.today_since)}, ${pump.today_by}`
												: 'Not set yet'}</small
										>{/if}
								</td>
							{/each}
							{#if showStrip}
								<td class="strip-cell" data-label="Day by day">
									<span
										class="strip"
										style="--days: {periodDays.length}"
										data-testid="status-strip"
									>
										{#each periodDays as date, i (date)}
											{@const status = pump.days[i] ?? 'none'}
											<i
												class="cell cell--{status}"
												class:cell--today={date === data.today}
												title="{day(date)}: {status === 'none'
													? date > data.today
														? 'still to come'
														: 'pump not added yet'
													: PUMP_WORK_STATUS_LABELS[status]}"
											></i>
										{/each}
									</span>
								</td>
							{/if}
							<td class="num" data-label="Active days">{pump.active_days}</td>
							<td class="num" class:idle={pump.idle_days} data-label="Idle days"
								>{pump.idle_days}</td
							>
							<td class="num" class:inactive={pump.inactive_days} data-label="Inactive days"
								>{pump.inactive_days}</td
							>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr class="total-row">
						<td colspan={showStrip ? 4 : 3}
							><strong>All {data.totals.pumps} {data.totals.pumps === 1 ? 'pump' : 'pumps'}</strong
							></td
						>
						<td class="num" data-label="Active days"><strong>{data.totals.active_days}</strong></td>
						<td class="num" data-label="Idle days"><strong>{data.totals.idle_days}</strong></td>
						<td class="num" data-label="Inactive days"
							><strong>{data.totals.inactive_days}</strong></td
						>
					</tr>
				</tfoot>
			</table>
		</div>
		{#if data.pagination.totalPages > 1}
			<nav class="pager" aria-label="Pump status pages">
				{#if data.pagination.page > 1}<a
						class="button button--secondary"
						href={link({ page: data.pagination.page - 1 })}>Previous</a
					>{:else}<span></span>{/if}
				<span>Page {data.pagination.page} of {data.pagination.totalPages}</span>
				{#if data.pagination.page < data.pagination.totalPages}<a
						class="button button--secondary"
						href={link({ page: data.pagination.page + 1 })}>Next</a
					>{/if}
			</nav>
		{/if}
	{:else}
		<EmptyState
			title="No pump matches"
			description="Clear the search or the Today filter to see every pump."
		/>
	{/if}
</div>

<style>
	.period {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		margin-bottom: var(--space-4);
	}
	.period-tabs {
		display: inline-flex;
		padding: 3px;
		background: var(--surface-muted);
		border-radius: var(--radius-lg);
	}
	.period-tabs a {
		min-width: 4.5rem;
		padding: var(--space-2) var(--space-3);
		color: var(--ink-default);
		font-weight: 600;
		text-align: center;
		text-decoration: none;
		border-radius: var(--radius-md);
	}
	.period-tabs a[aria-current='page'] {
		background: var(--surface-raised);
		color: var(--ink-strong);
		box-shadow: 0 1px 2px rgba(22, 38, 37, 0.15);
	}
	.period-step {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
	}
	.step {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		color: var(--ink-strong);
		border: 1px solid var(--surface-muted);
		border-radius: var(--radius-md);
		background: var(--surface-raised);
	}
	.step--off {
		opacity: 0.35;
	}
	.status-filter {
		grid-template-columns: minmax(0, 22rem) minmax(8rem, 11rem) auto;
		align-items: end;
	}
	.today-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin: var(--space-3) 0;
		color: var(--ink-muted);
	}
	.count {
		padding: var(--space-1) var(--space-3);
		color: var(--ink-strong);
		text-decoration: none;
		border: 1px solid transparent;
		border-radius: 999px;
	}
	.count[aria-current='true'] {
		border-color: currentColor;
	}
	.count--active,
	.pick-status--active {
		background: var(--primary-tint);
	}
	.count--idle,
	.pick-status--idle {
		background: #fff3d6;
		color: #6b4a00;
	}
	.count--inactive,
	.pick-status--inactive {
		background: var(--surface-muted);
		color: var(--ink-muted);
	}
	.status-table .pick {
		width: 1%;
	}
	.status-table th small {
		color: var(--ink-muted);
		font-weight: 400;
	}
	.status-table th small {
		display: block;
	}
	.table-head-line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2) var(--space-4);
		margin: var(--space-4) 0 var(--space-2);
	}
	.table-head-line p {
		margin: 0;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-3);
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
	}
	.strip {
		display: grid;
		grid-template-columns: repeat(var(--days), 0.5rem);
		gap: 2px;
	}
	.cell {
		display: block;
		width: 0.5rem;
		height: 1.25rem;
		border-radius: 2px;
	}
	.legend .cell {
		width: 0.75rem;
		height: 0.75rem;
	}
	.cell--active {
		background: var(--brand-teal);
	}
	.cell--idle {
		background: #e0a526;
	}
	.cell--inactive {
		background: var(--alert);
	}
	.cell--none {
		background: var(--surface-subtle);
		box-shadow: inset 0 0 0 1px var(--surface-muted);
	}
	.cell--today {
		outline: 2px solid var(--ink-strong);
		outline-offset: 1px;
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.idle {
		color: #6b4a00;
		font-weight: 700;
	}
	.inactive {
		color: var(--alert);
		font-weight: 700;
	}
	/* The sums stay at the bottom of the scrolling table, in view while the pumps scroll. */
	.total-row td {
		position: sticky;
		bottom: 0;
		background: var(--surface-muted);
		border-top: 2px solid var(--brand-mist);
	}
	.pump-cell strong,
	.pump-cell small {
		display: block;
		white-space: nowrap;
	}
	.pump-cell small,
	.since {
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}
	.since {
		display: block;
		max-width: 9rem;
		margin-top: var(--space-1);
		white-space: normal;
	}
	.row--inactive .pump-cell strong {
		color: var(--ink-muted);
	}
	.pick form {
		display: grid;
		gap: var(--space-1);
	}
	.pick-site {
		width: 9rem;
		min-height: 2.25rem;
		padding: 0 var(--space-2);
		font-size: var(--text-sm);
	}
	.pick-status {
		width: 9rem;
		min-width: 7.5rem;
		min-height: 2.5rem;
		padding: 0 var(--space-2);
		font-weight: 600;
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	@media (max-width: 40rem) {
		.status-filter {
			grid-template-columns: 1fr;
		}
		.period {
			flex-direction: column;
			align-items: stretch;
		}
		.period-tabs a {
			flex: 1;
		}
		.period-step {
			justify-content: space-between;
		}
		/* Each pump is a card: name, then Today and Tomorrow side by side, then the three day counts. */
		.status-table thead {
			display: none;
		}
		.status-table,
		.status-table tbody,
		.status-table tfoot {
			display: block;
		}
		.status-table tfoot {
			position: sticky;
			bottom: 0;
			z-index: 1;
		}
		.total-row {
			background: var(--surface-muted);
			border-top: 2px solid var(--brand-mist);
		}
		.total-row td {
			position: static;
			border-top: 0;
		}
		.status-table tr {
			display: grid;
			grid-template-columns: repeat(6, 1fr);
			gap: var(--space-2);
			padding: var(--space-3);
			border-bottom: 1px solid var(--surface-muted);
		}
		.status-table td {
			display: block;
			padding: 0;
			border: 0;
		}
		.status-table .pump-cell {
			grid-column: 1 / -1;
		}
		.status-table .pick {
			grid-column: span 3;
			width: auto;
		}
		.status-table .pick-status,
		.status-table .pick-site {
			width: 100%;
			min-width: 0;
		}
		.status-table td.num {
			grid-column: span 2;
			text-align: left;
		}
		.status-table td[data-label]::before {
			content: attr(data-label);
			display: block;
			color: var(--ink-muted);
			font-size: var(--text-xs);
			font-weight: 600;
		}
		.status-table .strip-cell {
			grid-column: 1 / -1;
		}
		.strip {
			grid-template-columns: repeat(var(--days), minmax(0, 1fr));
		}
		.strip .cell {
			width: auto;
		}
		.total-row td:first-child {
			grid-column: 1 / -1;
		}
		.since {
			white-space: normal;
		}
	}
</style>
