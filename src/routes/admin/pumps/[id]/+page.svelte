<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import AttendanceDailyBars from '$lib/components/AttendanceDailyBars.svelte';
	import AttendanceEvidenceButtons from '$lib/components/AttendanceEvidenceButtons.svelte';
	import DateRangePicker from '$lib/components/DateRangePicker.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';

	let { data, form } = $props();
	let from = $state('');
	let to = $state('');
	$effect(() => {
		if (!from) from = data.range.from;
		if (!to) to = data.range.to;
	});
	const entities = $derived(
		data.roster.map((person: any) => ({
			id: person.id,
			label: personDisplayLabel(data.pump.pump_code, person.display_seq)
		}))
	);
	const dailyBreakdownTotals = $derived(
		data.dailyBreakdown.reduce(
			(acc: any, d: any) => ({
				present: acc.present + d.present,
				morningOnly: acc.morningOnly + d.morningOnly,
				eveningOnly: acc.eveningOnly + d.eveningOnly
			}),
			{ present: 0, morningOnly: 0, eveningOnly: 0 }
		)
	);
	const rangeLabel = $derived(`${formatDate(data.range.from)} – ${formatDate(data.range.to)}`);
	const trendData = $derived(data.dailyBreakdown.slice(-5));

	function apply() {
		window.location.search = new URLSearchParams({ from, to }).toString();
	}
	function cellValue(personId: string, day: string) {
		return data.attendanceMap[`${personId}|${day}`] ?? 'absent';
	}
	function pageUrl(param: string, page: number) {
		const params = new URLSearchParams(window.location.search);
		params.set(param, String(page));
		return `?${params.toString()}`;
	}
</script>

<svelte:head><title>{data.pump.pump_code} | Face Attendance</title></svelte:head>

<div class="page detail-page">
	<a class="back-link" href="/admin/attendance"><ArrowLeft size={16} /> Attendance records</a>
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Pump</p>
			<h1>{data.pump.pump_code}</h1>
			<p>
				<a href={`/admin/vendors/${data.pump.vendor_id}`}>{data.pump.vendor_name}</a> · {data.pump
					.plant_name} · <a href={`/admin/areas/${data.pump.area_id}`}>{data.pump.area_name}</a>
			</p>
		</div>
	</header>
	{#if data.pump.status === 'disabled'}
		<div class="alert alert--error" role="status">
			<p>
				<strong>Pump login disabled</strong> — {data.pump.disabled_reason ?? 'unknown reason'}
				{#if data.pump.disabled_at}(since {formatDate(data.pump.disabled_at)}){/if}
			</p>
			<form method="POST" action="?/reactivatePump">
				<button type="submit">Reactivate login</button>
			</form>
		</div>
	{/if}

	<DateRangePicker bind:from bind:to onchange={apply} />

	{#if form?.message}
		<p class:alert--error={!form.success} class="alert" role="status">{form.message}</p>
	{/if}

	<div class="pump-summary section">
		<section class="surface surface--padded">
			<div class="section-header">
				<div>
					<h2>Attendance trend</h2>
					<p class="supporting-text">Latest five days, with newest first.</p>
				</div>
			</div>
			<div class="daily-bars-frame">
				<AttendanceDailyBars data={trendData} />
			</div>
		</section>
		<section class="surface surface--padded">
			<div class="section-header">
				<div>
					<h2>Daily attendance summary</h2>
					<p class="supporting-text">Totals for {rangeLabel}.</p>
				</div>
			</div>
			<div class="table-wrap daily-summary-frame">
				<table class="data-table daily-summary-table">
					<thead>
						<tr>
							<th>Day</th>
							<th>Present</th>
							<th>Morning</th>
							<th>Evening</th>
						</tr>
					</thead>
					<tbody>
						{#each [...data.dailyBreakdown].reverse() as d}
							<tr>
								<td>{formatDate(d.day)}</td>
								<td>{d.present}</td>
								<td>{d.morningOnly}</td>
								<td>{d.eveningOnly}</td>
							</tr>
						{/each}
					</tbody>
					<tfoot>
						<tr>
							<th>Range total</th>
							<th>{dailyBreakdownTotals.present}</th>
							<th>{dailyBreakdownTotals.morningOnly}</th>
							<th>{dailyBreakdownTotals.eveningOnly}</th>
						</tr>
					</tfoot>
				</table>
			</div>
			<p class="footnote">
				{data.rejectionCounts.morningOnly} morning-only session{data.rejectionCounts.morningOnly ===
				1
					? ''
					: 's'} this range &middot; {data.rejectionCounts.morningAwaiting} awaiting evening &middot;
				{data.rejectionCounts.morningExpired} expired
			</p>
		</section>
	</div>

	<section class="section">
		<div class="section-header">
			<div>
				<h2>Attendance calendar</h2>
				<p class="supporting-text">
					Person status by day, {rangeLabel} &middot; scroll for more days
				</p>
			</div>
		</div>
		<div class="calendar-frame">
			<AttendanceCalendarGrid
				days={data.days}
				{entities}
				{cellValue}
				mode="status"
				entityLabel="Person"
			/>
		</div>
		{#if data.rosterPagination.totalPages > 1}
			<nav class="pager" aria-label="Roster pagination">
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
	</section>

	<section class="section">
		<div class="section-header">
			<div>
				<h2>Session log</h2>
				<p class="supporting-text">Persisted sessions and pairing outcomes.</p>
			</div>
		</div>
		<div class="table-wrap bounded-table-frame">
			<table class="data-table">
				<thead
					><tr
						><th>Submitted</th><th>Type</th><th>Status</th><th>Pairing</th><th>Evidence</th><th
							>Error or rejection</th
						></tr
					></thead
				><tbody
					>{#each data.sessionLog as session}<tr
							><td>{formatDate(session.submitted_at)}</td><td>{session.session_type}</td><td
								><StatusBadge
									tone={session.status === 'completed'
										? 'success'
										: session.status === 'failed' || session.status === 'fraud_detected'
											? 'critical'
											: 'pending'}
									label={session.status}
								/></td
							><td>{session.pairing_status}</td><td
								><AttendanceEvidenceButtons session={session.evidence} /></td
							><td
								>{#if session.status === 'fraud_detected'}<div class="fraud-review">
										{#if session.fraud_resolution === 'marked_normal'}<span
												>Marked normal — reprocessed</span
											>{:else if session.fraud_resolution === 'confirmed_fraud'}<span
												>Confirmed fraud</span
											>{:else}<form method="POST" action="?/resolveFraudSession">
												<input type="hidden" name="session_id" value={session.id} /><input
													type="hidden"
													name="resolution"
													value="marked_normal"
												/><button type="submit" class="button button--secondary"
													>Mark as normal</button
												>
											</form>
											<form method="POST" action="?/resolveFraudSession">
												<input type="hidden" name="session_id" value={session.id} /><input
													type="hidden"
													name="resolution"
													value="confirmed_fraud"
												/><button type="submit" class="button button--secondary"
													>Confirm fraud</button
												>
											</form>{/if}
									</div>{:else}{session.error_reason ||
										(session.pairing_status === 'expired'
											? 'Morning session expired unpaired'
											: '—')}{/if}</td
							></tr
						>{/each}</tbody
				>
			</table>
		</div>
		<p class="footnote">
			Nine-hour and duplicate-photo rejections occur before a session is created, so only the
			operator’s live response contains them.
		</p>
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
	</section>

	<section class="section">
		<div class="section-header"><h2>Worker roster</h2></div>
		<div class="table-wrap bounded-table-frame">
			<table class="data-table">
				<thead
					><tr
						><th>Person</th><th>First seen</th><th>Last seen</th><th>Present</th><th
							>Morning only</th
						><th>Evening only</th></tr
					></thead
				><tbody
					>{#each data.roster as person}<tr
							><td
								><a href={`/admin/persons/${person.id}`}
									>{personDisplayLabel(data.pump.pump_code, person.display_seq)}</a
								></td
							><td>{formatDate(person.first_seen_at)}</td><td>{formatDate(person.last_seen_at)}</td
							><td>{person.days_present}</td><td>{person.days_morning_only}</td><td
								>{person.days_evening_only}</td
							></tr
						>{/each}</tbody
				>
			</table>
		</div>
		<p class="footnote">Same page as the calendar above — use its pager to see more people.</p>
	</section>
</div>

<style>
	.detail-page {
		--content-max: 82rem;
	}
	.fraud-review {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		align-items: center;
	}
	.fraud-review form {
		display: contents;
	}
	.back-link {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		margin-bottom: var(--space-5);
		font-size: var(--text-sm);
		font-weight: 600;
		text-decoration: none;
	}
	.eyebrow {
		margin: 0 0 var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
	}
	.pump-summary {
		display: grid;
		grid-template-columns: minmax(0, 55fr) minmax(20rem, 35fr);
		gap: var(--space-4);
	}
	.daily-summary-table th,
	.daily-summary-table td {
		text-align: right;
	}
	.daily-summary-table th:first-child,
	.daily-summary-table td:first-child {
		text-align: left;
	}
	.daily-summary-frame {
		max-height: 25rem;
		overflow-x: hidden;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
		scrollbar-width: thin;
		scrollbar-color: var(--brand-mist) var(--surface-muted);
	}
	.daily-summary-table thead th {
		position: sticky;
		top: 0;
		z-index: 3;
	}
	.daily-summary-table tfoot th {
		position: sticky;
		top: auto;
		bottom: 0;
		z-index: 3;
		background: var(--surface-muted);
		box-shadow: 0 -1px 0 var(--brand-mist);
	}
	.daily-bars-frame {
		overflow: hidden;
	}
	.bounded-table-frame {
		max-height: 22rem;
		overflow: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
		scrollbar-width: thin;
		scrollbar-color: var(--brand-mist) var(--surface-muted);
	}
	.footnote {
		margin: var(--space-2) 0 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.calendar-frame :global(.grid-wrap) {
		width: 100%;
	}
	.pager {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		margin-top: var(--space-3);
	}
	@media (max-width: 48rem) {
		.pump-summary {
			grid-template-columns: 1fr;
		}
	}
</style>
