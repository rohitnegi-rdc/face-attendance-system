<script lang="ts">
	import { resolve } from '$app/paths';
	import Download from '@lucide/svelte/icons/download';
	import Search from '@lucide/svelte/icons/search';
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import ShiftLog from '$lib/components/ShiftLog.svelte';
	import { calendarDays, dateKey, formatDate, todayStr } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	const days = $derived(calendarDays(data.filters.from, data.filters.to));
	const entities = $derived(
		data.pumps.map((pump: any) => ({ id: pump.id, label: pump.pump_code }))
	);
	// Keeps the date range, the pump and the other list's page when one list pages.
	function pageUrl(param: 'session_page' | 'roster_page', page: number) {
		const params = new URLSearchParams({ from: data.filters.from, to: data.filters.to });
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
			)
		}))
	);
	const personStatus = (personId: string, day: string) =>
		data.attendanceMap[`${personId}|${day}`] ?? 'absent';
	const rangeLabel = $derived(`${formatDate(data.filters.from)} – ${formatDate(data.filters.to)}`);
	const lookup = $derived(
		new Map(
			data.daily.map((row: any) => [
				`${row.pump_id}:${dateKey(row.session_date)}`,
				Number(row.attendance_pct)
			])
		)
	);
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
	<form class="filter-bar compact-filter" method="GET">
		<label class="field"
			><span>From</span><input type="date" name="from" value={data.filters.from} /></label
		><label class="field"
			><span>To</span><input type="date" name="to" value={data.filters.to} /></label
		><label class="field"
			><span>Pump</span><select name="pump" value={data.filters.pump} data-testid="pm-pump-filter"
				><option value="">All pumps</option>{#each data.pumps as pump (pump.id)}<option
						value={pump.id}>{pump.pump_code}</option
					>{/each}</select
			></label
		>
		<div class="filter-actions">
			<button class="button button--primary" type="submit"><Search size={17} /> Apply</button>
		</div>
	</form>
	<section class="section">
		<div class="section-header">
			<div>
				<h2>Daily attendance</h2>
				<p class="supporting-text">Full shift (start and end) matches by pump.</p>
			</div>
		</div>
		{#if data.daily.length}<AttendanceCalendarGrid
				{days}
				{entities}
				mode="percent"
				cellValue={(entity, day) => lookup.get(`${entity}:${day}`) ?? null}
			/>{:else}<EmptyState
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
		<div class="section-header">
			<div>
				<h2 id="session-log-title">Session log and photos</h2>
				<p class="supporting-text">
					{data.sessionPagination.total}
					{data.sessionPagination.total === 1 ? 'shift' : 'shifts'} in this range, newest first. Each
					row is one shift, start photo and end photo side by side. Open a group photo or a worker to
					see who was counted.
				</p>
			</div>
		</div>
		{#if data.shifts.length}
			<ShiftLog
				shifts={data.shifts}
				page={data.sessionPagination.page}
				pageSize={data.sessionPagination.pageSize}
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
	/* One row: export, then the month and its button, bottoms aligned; wraps on a phone. */
	.header-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-3);
	}
	.headcount-form {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-3);
	}
	.header-actions .button {
		white-space: nowrap;
	}
	.compact-filter {
		grid-template-columns: repeat(3, minmax(11rem, 16rem)) auto;
		justify-content: start;
	}
	.calendar-frame :global(.grid-wrap) {
		width: 100%;
	}
	@media (max-width: 38rem) {
		/* One row: export, then the month and its button, bottoms aligned; wraps on a phone. */
		.header-actions {
			display: flex;
			flex-wrap: wrap;
			align-items: flex-end;
			gap: var(--space-3);
		}
		.headcount-form {
			display: flex;
			flex-wrap: wrap;
			align-items: flex-end;
			gap: var(--space-3);
		}
		.header-actions .button {
			white-space: nowrap;
		}
		.compact-filter {
			grid-template-columns: 1fr;
		}
	}
</style>
