<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import ScanSearch from '@lucide/svelte/icons/scan-search';
	import MetricStrip from '$lib/components/MetricStrip.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/date';

	let { data } = $props();

	const metrics = $derived([
		{ label: 'Attendance today', value: `${data.metrics.attendancePct}%` },
		{ label: 'Active pumps', value: data.metrics.activePumps },
		{ label: 'Known people', value: data.metrics.totalPersons },
		{ label: 'Fraud flags today', value: data.metrics.fraudFlagsToday },
		{ label: 'Guest reviews', value: data.metrics.pendingGuestReviews },
		{ label: 'Merge reviews', value: data.metrics.pendingMergeReviews },
		{
			label: 'Average elapsed',
			value: data.metrics.avgElapsedHours === 'N/A' ? 'N/A' : `${data.metrics.avgElapsedHours}h`
		}
	]);

	const reviewQueues = $derived([
		{
			label: 'Fraud flags',
			count: data.metrics.fraudFlagsToday,
			href: '/admin/fraud-flags',
			detail: 'Cross-pump overlaps detected today'
		},
		{
			label: 'Guest review',
			count: data.metrics.pendingGuestReviews,
			href: '/admin/flagged-guests',
			detail: 'Unmatched faces awaiting a decision'
		},
		{
			label: 'Merge review',
			count: data.metrics.pendingMergeReviews,
			href: '/admin/merge-candidates',
			detail: 'Possible same-pump duplicates'
		}
	]);
</script>

<svelte:head><title>Overview | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Operations</p>
			<h1>Overview</h1>
			<p>Attendance health and review work across the system.</p>
		</div>
		<a class="button button--secondary" href="/admin/insights"
			>Open insights <ArrowRight size={17} /></a
		>
	</header>

	<MetricStrip {metrics} testId="admin-metrics" />

	<div class="overview-grid section">
		<section class="surface surface--padded trend-panel">
			<div class="section-header">
				<div>
					<h2>Seven-day attendance</h2>
					<p>Fully matched morning and evening attendance.</p>
				</div>
				<strong>{data.trend.at(-1)?.attendance_pct || 0}%</strong>
			</div>
			<Sparkline
				values={data.trend.map((day: any) => Number(day.attendance_pct))}
				width={620}
				height={110}
				label="Seven-day attendance percentage"
			/>
			<table class="sr-only">
				<caption>Seven-day attendance percentage</caption>
				<thead><tr><th>Date</th><th>Attendance</th></tr></thead>
				<tbody
					>{#each data.trend as day}<tr
							><td>{formatDate(day.day)}</td><td>{day.attendance_pct}%</td></tr
						>{/each}</tbody
				>
			</table>
			<div class="trend-labels">
				<span>{formatDate(data.trend[0]?.day)}</span>
				<span>{formatDate(data.trend.at(-1)?.day)}</span>
			</div>
		</section>

		<section class="surface review-queue">
			<div class="queue-heading">
				<div>
					<h2>Review queue</h2>
					<p>Open work ordered by urgency.</p>
				</div>
				<ScanSearch size={22} />
			</div>
			{#each reviewQueues as queue}
				<a class="queue-row" href={queue.href}>
					<span><strong>{queue.label}</strong><small>{queue.detail}</small></span>
					<span class="queue-count">{queue.count}</span>
					<ArrowRight size={17} />
				</a>
			{/each}
		</section>
	</div>

	<section class="section">
		<div class="section-header">
			<div>
				<h2>Recent attendance activity</h2>
				<p class="supporting-text">Latest submissions from every pump.</p>
			</div>
			<a href="/admin/attendance">View records</a>
		</div>
		<div class="table-wrap">
			<table class="data-table">
				<thead
					><tr><th>Pump</th><th>Plant</th><th>Session</th><th>Submitted</th><th>Status</th></tr
					></thead
				>
				<tbody>
					{#each data.recentActivity as session}
						<tr>
							<td><a href={`/admin/pumps/${session.pump_id}`}>{session.pump_code}</a></td>
							<td>{session.plant_name}</td>
							<td>{session.session_type}</td>
							<td>{formatDate(session.submitted_at)}</td>
							<td
								><StatusBadge
									tone={session.status === 'completed'
										? 'success'
										: session.status === 'failed'
											? 'critical'
											: 'pending'}
									label={session.status}
								/></td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
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
	.overview-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.55fr) minmax(18rem, 0.8fr);
		gap: var(--space-4);
		align-items: stretch;
	}
	.section-header p {
		margin: var(--space-1) 0 0;
	}
	.trend-panel {
		min-width: 0;
	}
	.trend-panel :global(.sparkline) {
		width: 100%;
		height: 7rem;
		margin: var(--space-6) 0 var(--space-2);
	}
	.trend-panel .section-header strong {
		color: var(--ink-strong);
		font-size: var(--text-2xl);
	}
	.trend-labels {
		display: flex;
		justify-content: space-between;
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}
	.review-queue {
		overflow: hidden;
	}
	.queue-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		padding: var(--space-4);
		border-bottom: 1px solid var(--brand-mist);
	}
	.queue-heading h2 {
		margin: 0;
	}
	.queue-heading p {
		margin: var(--space-1) 0 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.queue-heading :global(svg) {
		color: var(--brand-teal);
	}
	.queue-row {
		display: grid;
		grid-template-columns: 1fr auto auto;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-4);
		color: var(--ink-default);
		text-decoration: none;
		border-bottom: 1px solid var(--brand-mist);
	}
	.queue-row:last-child {
		border-bottom: 0;
	}
	.queue-row:hover {
		background: var(--surface-subtle);
	}
	.queue-row > span:first-child {
		display: grid;
	}
	.queue-row small {
		color: var(--ink-muted);
	}
	.queue-count {
		min-width: 2rem;
		color: var(--ink-strong);
		font-size: var(--text-lg);
		font-weight: 700;
		text-align: right;
	}
	@media (max-width: 64rem) {
		.overview-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
