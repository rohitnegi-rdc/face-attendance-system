<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import CalendarCheck from '@lucide/svelte/icons/calendar-check';
	import ScanSearch from '@lucide/svelte/icons/scan-search';
	import MetricStrip from '$lib/components/MetricStrip.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/date';

	let { data } = $props();

	const metrics = $derived([
		{
			label: 'Present today',
			value: `${data.metrics.presentToday} of ${data.metrics.totalToday}`,
			detail: `${data.metrics.attendancePct}% completed both sessions`
		},
		{ label: 'Reporting pumps', value: data.metrics.activePumps, detail: 'Submitted today' },
		{ label: 'Active workers', value: data.metrics.totalPersons, detail: 'Known identities' },
		{
			label: 'Morning to evening',
			value: data.metrics.avgElapsedHours === 'N/A' ? 'Not available' : `${data.metrics.avgElapsedHours}h`,
			detail: 'Average interval today'
		}
	]);

	const reviewQueues = $derived([
		{
			label: 'Fraud flags',
			count: data.metrics.fraudFlagsToday,
			href: resolve('/admin/fraud-flags'),
			detail: 'Cross-pump overlaps detected today'
		},
		{
			label: 'Guest review',
			count: data.metrics.pendingGuestReviews,
			href: resolve('/admin/flagged-guests'),
			detail: 'Unmatched faces awaiting a decision'
		},
		{
			label: 'Merge review',
			count: data.metrics.pendingMergeReviews,
			href: resolve('/admin/merge-candidates'),
			detail: 'Possible same-pump duplicates'
		}
	]);
</script>

<svelte:head><title>Overview | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<h1>Attendance operations</h1>
			<p>See today’s coverage, resolve exceptions, and inspect recent submissions.</p>
		</div>
		<a class="button button--secondary" href={resolve('/admin/insights')}
			>Open insights <ArrowRight size={17} /></a
		>
	</header>

	<section class="today-summary" aria-labelledby="today-heading">
		<div class="today-summary__lead">
			<div class="today-summary__icon"><CalendarCheck size={22} /></div>
			<div>
				<h2 id="today-heading">Today</h2>
				<p><strong>{data.metrics.presentToday}</strong> fully present out of <strong>{data.metrics.totalToday}</strong> recorded workers</p>
			</div>
		</div>
		<div class="coverage" aria-label={`${data.metrics.attendancePct}% attendance today`}>
			<div class="coverage__track"><span style={`width: ${data.metrics.attendancePct}%`}></span></div>
			<strong>{data.metrics.attendancePct}%</strong>
		</div>
	</section>

	<MetricStrip {metrics} testId="admin-metrics" />

	<div class="overview-grid section">
		<section class="surface surface--padded trend-panel" aria-labelledby="trend-heading">
			<div class="section-header">
				<div>
					<h2 id="trend-heading">Attendance trend</h2>
					<p>Workers matched in both morning and evening sessions over seven days.</p>
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

		<section class="surface review-queue" aria-labelledby="review-heading">
			<div class="queue-heading">
				<div>
					<h2 id="review-heading">Needs your attention</h2>
					<p>Resolve exceptions before closing attendance.</p>
				</div>
				<ScanSearch size={22} />
			</div>
			{#each reviewQueues as queue, index}
				<a class="queue-row" href={queue.href}>
					<span class="queue-rank">{index + 1}</span>
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
				<h2>Latest submissions</h2>
				<p class="supporting-text">Most recent morning and evening uploads across pumps.</p>
			</div>
			<a href={resolve('/admin/attendance')}>View records</a>
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
							<td><a href={resolve(`/admin/pumps/${session.pump_id}`)}>{session.pump_code}</a></td>
							<td>{session.plant_name}</td>
							<td><span class="session-type">{session.session_type === 'morning' ? 'Morning' : 'Evening'}</span></td>
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
	.today-summary {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(15rem, 0.65fr);
		align-items: center;
		gap: var(--space-6);
		margin-bottom: var(--space-3);
		padding: var(--space-4) var(--space-5);
		color: var(--ink-strong);
		background: var(--primary-tint);
		border: 1px solid #8bd9cf;
		border-radius: var(--radius-lg);
	}
	.today-summary__lead {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
	.today-summary__icon {
		display: grid;
		width: 2.75rem;
		height: 2.75rem;
		flex: 0 0 auto;
		place-items: center;
		color: var(--primary-on);
		background: var(--brand-teal);
		border-radius: var(--radius-md);
	}
	.today-summary h2,
	.today-summary p { margin: 0; }
	.today-summary p { margin-top: var(--space-1); color: var(--ink-default); }
	.coverage {
		display: grid;
		grid-template-columns: minmax(8rem, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
	}
	.coverage__track {
		height: 0.5rem;
		overflow: hidden;
		background: rgb(255 255 255 / 75%);
		border-radius: var(--radius-sm);
	}
	.coverage__track span { display: block; height: 100%; background: var(--brand-teal); }
	.coverage strong { font-size: var(--text-lg); font-variant-numeric: tabular-nums; }
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
		grid-template-columns: 1.75rem 1fr auto auto;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-4);
		color: var(--ink-default);
		text-decoration: none;
		border-bottom: 1px solid var(--brand-mist);
	}
	.queue-rank {
		display: grid;
		width: 1.75rem;
		height: 1.75rem;
		place-items: center;
		color: var(--ink-muted);
		background: var(--surface-muted);
		border-radius: var(--radius-sm);
		font-size: var(--text-xs);
		font-weight: 700;
	}
	.queue-row:last-child {
		border-bottom: 0;
	}
	.queue-row:hover {
		background: var(--surface-subtle);
	}
	.queue-row > span:nth-child(2) {
		display: grid;
		gap: 0.125rem;
		min-width: 0;
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
	.session-type { text-transform: capitalize; }
	@media (max-width: 64rem) {
		.overview-grid {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 47.99rem) {
		.today-summary { grid-template-columns: 1fr; gap: var(--space-4); padding: var(--space-4); }
		.queue-row { grid-template-columns: 1.75rem 1fr auto auto; padding: var(--space-3); }
	}
</style>
