<script lang="ts">
	import { resolve } from '$app/paths';
	import Download from '@lucide/svelte/icons/download';
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import GangHeadcountGrid from '$lib/components/GangHeadcountGrid.svelte';
	import ShiftLog from '$lib/components/ShiftLog.svelte';
	import ShiftSplit from '$lib/components/ShiftSplit.svelte';
	import { calendarDays, dateKey, formatDate, todayStr } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';
	import { applyOnChange } from '$lib/liveSearch';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	// By pump (attendance %) or By gang (headcount, each worker once a day); By gang only shows
	// where the Area has gangs on.
	let dailyView = $state<'pump' | 'gang'>('pump');
	const days = $derived(calendarDays(data.filters.from, data.filters.to));
	// The Pump list follows the chosen Plant; the filters apply to every list below.
	let plant = $state('');
	let pump = $state('');
	$effect.pre(() => {
		plant = data.filters.plant;
		pump = data.filters.pump;
	});
	const pumpChoices = $derived(
		plant ? data.pumps.filter((p: any) => p.plant_id === plant) : data.pumps
	);
	// Only pumps Active or Idle in the range, or with attendance in it (gridPumps): an Inactive pump
	// is not a row of zeros.
	const entities = $derived(
		data.gridPumps.map((pump: any) => ({ id: pump.id, label: pump.pump_code }))
	);
	const openShifts = $derived(new Set(data.openShifts));
	// Keeps the date range, the pump and the other list's page when one list pages.
	function pageUrl(param: 'session_page' | 'roster_page', page: number) {
		const params = new URLSearchParams({ from: data.filters.from, to: data.filters.to });
		if (data.filters.plant) params.set('plant', data.filters.plant);
		if (data.filters.pump) params.set('pump', data.filters.pump);
		if (param === 'session_page' && data.rosterPagination.page > 1)
			params.set('roster_page', String(data.rosterPagination.page));
		if (param === 'roster_page' && data.sessionPagination.page > 1)
			params.set('session_page', String(data.sessionPagination.page));
		params.set(param, String(page));
		return `?${params.toString()}`;
	}
	// Person x day calendar, the same rows and letters as the admin pump page.
	const people = $derived(
		data.roster.map((person: any) => ({
			id: person.id,
			label: personDisplayLabel(
				person.pump_code,
				person.display_seq,
				person.is_operator,
				person.name
			),
			faceUrl: resolve('/api/persons/[id]/face', { id: person.id })
		}))
	);
	const personStatus = (personId: string, day: string) =>
		data.attendanceMap[`${personId}|${day}`] ?? 'absent';
	const rangeLabel = $derived(`${formatDate(data.filters.from)} – ${formatDate(data.filters.to)}`);
	// Workers by shift per pump and day, and the same three added up over the range per pump.
	type Split = { full: number; startOnly: number; endOnly: number };
	const lookup = $derived(
		new Map<string, Split>(
			data.daily.map((row: any) => [
				`${row.pump_id}:${dateKey(row.session_date)}`,
				{ full: row.full_shift, startOnly: row.start_only, endOnly: row.end_only }
			])
		)
	);
	const pumpTotals = $derived(
		data.gridPumps.map((pump: any) => {
			const total = { full: 0, startOnly: 0, endOnly: 0 };
			for (const row of data.daily)
				if (row.pump_id === pump.id) {
					total.full += row.full_shift;
					total.startOnly += row.start_only;
					total.endOnly += row.end_only;
				}
			return { id: pump.id, code: pump.pump_code, ...total };
		})
	);
	function splitCell(pumpId: string, day: string) {
		const split = lookup.get(`${pumpId}:${day}`);
		const open = openShifts.has(`${pumpId}:${day}`);
		if (!split) return open ? { full: 0, startOnly: 0, endOnly: 0, open } : null;
		return { ...split, open };
	}
</script>

<svelte:head><title>Plant attendance | Face Attendance</title></svelte:head>
<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Plant manager</p>
			<h1>Attendance</h1>
			<p>Attendance and session evidence for your assigned plants.</p>
		</div>
		<div class="header-actions">
			<a
				class="button button--secondary"
				href={resolve(
					`/plant-manager/attendance/export?${new URLSearchParams({ from: data.filters.from, to: data.filters.to })}`
				)}
				data-sveltekit-reload
			>
				<Download size={17} /> Export report
			</a>
			<form
				class="headcount-form"
				method="GET"
				action={resolve('/plant-manager/attendance/export')}
				data-sveltekit-reload
			>
				<input type="hidden" name="report" value="headcount" />
				<label class="field"
					><span>Headcount month</span><input
						type="month"
						name="month"
						value={todayStr().slice(0, 7)}
						max={todayStr().slice(0, 7)}
					/></label
				>
				<button class="button button--secondary" type="submit"
					><Download size={17} /> Headcount report</button
				>
			</form>
		</div>
	</header>
	<!-- Applies as soon as a date or a dropdown is picked, like the rest of the app. -->
	<form class="filter-bar compact-filter" method="GET" onchange={applyOnChange}>
		<label class="field"
			><span>From</span><input type="date" name="from" value={data.filters.from} /></label
		><label class="field"
			><span>To</span><input type="date" name="to" value={data.filters.to} /></label
		>{#if data.plants.length > 1}<label class="field"
				><span>Plant</span><select
					name="plant"
					bind:value={plant}
					onchange={() => (pump = '')}
					data-testid="pm-plant-filter"
					><option value="">All plants</option>{#each data.plants as p (p.id)}<option value={p.id}
							>{p.name}</option
						>{/each}</select
				></label
			>{/if}<label class="field"
			><span>Pump</span><select name="pump" bind:value={pump} data-testid="pm-pump-filter"
				><option value="">All pumps</option>{#each pumpChoices as p (p.id)}<option value={p.id}
						>{p.pump_code}</option
					>{/each}</select
			></label
		>
	</form>
	<section class="section">
		<div class="section-header">
			<div>
				<h2>Daily attendance</h2>
				<p class="supporting-text">
					{dailyView === 'gang' && data.gangView
						? 'Workers of each gang counted per day, wherever the gang worked.'
						: 'Workers of each pump per day: full shift, start only and end only.'}
				</p>
			</div>
			{#if data.gangView}
				<div class="view-toggle" role="group" aria-label="Show daily attendance">
					<button
						type="button"
						aria-pressed={dailyView === 'pump'}
						onclick={() => (dailyView = 'pump')}>By pump</button
					>
					<button
						type="button"
						aria-pressed={dailyView === 'gang'}
						data-testid="by-gang"
						onclick={() => (dailyView = 'gang')}>By gang</button
					>
				</div>
			{/if}
		</div>
		{#if dailyView === 'gang' && data.gangView}<GangHeadcountGrid
				view={data.gangView}
				{days}
				base="plant-manager"
			/>{:else if entities.length}<AttendanceCalendarGrid
				{days}
				{entities}
				mode="split"
				entityLabel="Pump"
				cellValue={splitCell}
			/>
			<h3 class="totals-title">Total for {rangeLabel}</h3>
			<ul class="pump-totals" data-testid="pump-totals">
				{#each pumpTotals as row (row.id)}
					<li data-testid="pump-total">
						<span class="pump-totals__code">{row.code}</span>
						<ShiftSplit full={row.full} startOnly={row.startOnly} endOnly={row.endOnly} />
					</li>
				{/each}
			</ul>{:else}<EmptyState
				title="No attendance in this range"
				description="Choose another date range."
			/>{/if}
	</section>
	<section class="section" aria-labelledby="calendar-title" data-testid="pm-person-calendar">
		<div class="section-header">
			<div>
				<h2 id="calendar-title">Attendance calendar</h2>
				<p class="supporting-text">
					Person status by day, {rangeLabel} &middot; {data.rosterPagination.total}
					{data.rosterPagination.total === 1 ? 'person' : 'people'} &middot; scroll for more days
				</p>
			</div>
		</div>
		{#if people.length}
			<div class="calendar-frame">
				<AttendanceCalendarGrid
					{days}
					entities={people}
					cellValue={personStatus}
					mode="status"
					entityLabel="Person"
				/>
			</div>
			{#if data.rosterPagination.totalPages > 1}
				<nav class="pager" aria-label="Attendance calendar pagination">
					{#if data.rosterPagination.page > 1}<a
							class="button button--secondary"
							href={pageUrl('roster_page', data.rosterPagination.page - 1)}>Previous</a
						>{:else}<span></span>{/if}
					<span>Page {data.rosterPagination.page} of {data.rosterPagination.totalPages}</span>
					{#if data.rosterPagination.page < data.rosterPagination.totalPages}<a
							class="button button--secondary"
							href={pageUrl('roster_page', data.rosterPagination.page + 1)}>Next</a
						>{/if}
				</nav>
			{/if}
		{:else}<EmptyState
				title="No people yet"
				description="People appear here after their pump sends its first shift photo."
			/>{/if}
	</section>
	<section class="section" aria-labelledby="session-log-title">
		<div class="section-header log-head">
			<div>
				<h2 id="session-log-title">Session log and photos</h2>
				<p class="supporting-text">
					{data.sessionPagination.total}
					{data.sessionPagination.total === 1 ? 'shift' : 'shifts'} in this range, newest first. Each
					row is one shift, start photo and end photo side by side. The newest day shows its photos and
					faces; tap one to see it big.
				</p>
			</div>
		</div>
		{#if data.shifts.length}
			<ShiftLog
				shifts={data.shifts}
				page={data.sessionPagination.page}
				pageSize={data.sessionPagination.pageSize}
				allowRename
				photosOnLatestDay
				fixHref={(shift, day) =>
					resolve(`/plant-manager/attendance/correct?pump=${shift.pump_id}&day=${day}`)}
				fraudCaseHref={(id) => resolve('/plant-manager/approvals/fraud/[id]', { id })}
			/>
			{#if data.sessionPagination.totalPages > 1}
				<nav class="pager" aria-label="Session log pagination">
					{#if data.sessionPagination.page > 1}<a
							class="button button--secondary"
							href={pageUrl('session_page', data.sessionPagination.page - 1)}>Previous</a
						>{:else}<span></span>{/if}
					<span>Page {data.sessionPagination.page} of {data.sessionPagination.totalPages}</span>
					{#if data.sessionPagination.page < data.sessionPagination.totalPages}<a
							class="button button--secondary"
							href={pageUrl('session_page', data.sessionPagination.page + 1)}>Next</a
						>{/if}
				</nav>
			{/if}
		{:else}<EmptyState title="No sessions" description="Pump submissions will appear here." />{/if}
	</section>
</div>

<style>
	.totals-title {
		margin: var(--space-4) 0 var(--space-2);
		font-size: var(--text-sm);
	}
	.pump-totals {
		display: grid;
		gap: var(--space-1);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.pump-totals li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--brand-mist);
	}
	.pump-totals__code {
		min-width: 9rem;
		font-weight: 700;
	}
	.log-head {
		flex-wrap: wrap;
	}
	.eyebrow {
		margin: 0 0 var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
	}
	.supporting-text {
		margin: 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.compact-filter {
		grid-template-columns: repeat(4, minmax(9rem, 14rem));
		justify-content: start;
	}
	.calendar-frame :global(.grid-wrap) {
		width: 100%;
	}
	/* Phone: From and To side by side, Plant and Pump below, instead of four stacked rows. */
	@media (max-width: 38rem) {
		.compact-filter {
			grid-template-columns: 1fr 1fr;
		}
	}
</style>
