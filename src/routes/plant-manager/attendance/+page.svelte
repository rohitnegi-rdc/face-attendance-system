<script lang="ts">
	import { resolve } from '$app/paths';
	import Download from '@lucide/svelte/icons/download';
	import Search from '@lucide/svelte/icons/search';
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import ShiftLog from '$lib/components/ShiftLog.svelte';
	import { calendarDays, dateKey, todayStr } from '$lib/date';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	const days = $derived(calendarDays(data.filters.from, data.filters.to));
	const entities = $derived(
		data.pumps.map((pump: any) => ({ id: pump.id, label: pump.pump_code }))
	);
	function sessionPageUrl(page: number) {
		const params = new URLSearchParams({ from: data.filters.from, to: data.filters.to });
		params.set('session_page', String(page));
		return `?${params.toString()}`;
	}
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
							href={sessionPageUrl(data.sessionPagination.page - 1)}>Previous</a
						>{:else}<span></span>{/if}
					<span>Page {data.sessionPagination.page} of {data.sessionPagination.totalPages}</span>
					{#if data.sessionPagination.page < data.sessionPagination.totalPages}<a
							class="button button--secondary"
							href={sessionPageUrl(data.sessionPagination.page + 1)}>Next</a
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
		grid-template-columns: repeat(2, minmax(11rem, 16rem)) auto;
		justify-content: start;
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
