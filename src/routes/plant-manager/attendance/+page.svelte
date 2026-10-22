<script lang="ts">
	import { resolve } from '$app/paths';
	import Download from '@lucide/svelte/icons/download';
	import Search from '@lucide/svelte/icons/search';
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import AttendanceEvidenceButtons from '$lib/components/AttendanceEvidenceButtons.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import LocationBadge from '$lib/components/LocationBadge.svelte';
	import { calendarDays, dateKey, formatDate, todayStr } from '$lib/date';
	import { shiftOutcomeLabel, shiftTypeLabel } from '$lib/shiftLabels';
	let { data } = $props();
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
	<section class="section">
		<div class="section-header">
			<div>
				<h2>Session log and photos</h2>
				<p class="supporting-text">
					{data.sessionPagination.total} sessions in this range. Open a group photo or a worker to see
					who was counted.
				</p>
			</div>
		</div>
		{#if data.sessions.length}
			<div class="table-wrap">
				<table class="data-table">
					<thead
						><tr
							><th>Date</th><th>Pump</th><th>Shift</th><th>Status</th><th>Evidence</th><th>Note</th
							></tr
						></thead
					><tbody>
						{#each data.sessions as row (row.id)}<tr class:row-fraud={row.fraudPumps.length > 0}>
								<td
									>{formatDate(row.session_date)}<br /><small class="supporting-text"
										>sent {formatDate(row.submitted_at)}</small
									></td
								>
								<td>{row.pump_code}<br /><small class="supporting-text">{row.plant_name}</small></td
								>
								<td
									>{shiftTypeLabel(row.session_type)}{#if row.session_type === 'morning'}<br
										/><small class="supporting-text">{shiftOutcomeLabel(row)}</small>{/if}</td
								>
								<td
									><StatusBadge
										tone={row.status === 'completed'
											? 'success'
											: row.status === 'failed' || row.status === 'fraud_detected'
												? 'critical'
												: 'pending'}
										label={row.status}
									/><LocationBadge status={row.location_status} />{#if row.fraudPumps.length}<span
											class="fraud-row-badge"
											data-testid="fraud-row-badge">Same person at {row.fraudPumps.join(', ')}</span
										>{/if}</td
								>
								<td
									><AttendanceEvidenceButtons
										session={row.evidence}
										allowFlag={false}
										fraudCaseHref={(id) => resolve('/plant-manager/approvals/fraud/[id]', { id })}
									/></td
								>
								<td>{row.error_reason ?? ''}</td>
							</tr>{/each}
					</tbody>
				</table>
			</div>
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
