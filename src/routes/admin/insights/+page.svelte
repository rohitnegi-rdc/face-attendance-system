<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Minus from '@lucide/svelte/icons/minus';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';

	let { data } = $props();

	function fmtDelta(value: number) {
		return value > 0 ? `+${value}` : `${value}`;
	}

	function deltaIcon(value: number) {
		return value > 0 ? ArrowUp : value < 0 ? ArrowDown : Minus;
	}

	let AttendanceYesterdayIcon = $derived(deltaIcon(data.trends.attendancePct.vsYesterday));
	let AttendanceAverageIcon = $derived(deltaIcon(data.trends.attendancePct.vs7dAvg));
	let FraudIcon = $derived(deltaIcon(data.trends.fraudFlags.vsYesterday));
	let PumpsIcon = $derived(deltaIcon(data.trends.activePumps.vsYesterday));
</script>

<svelte:head><title>Insights | Face Attendance</title></svelte:head>

<div class="page insights-page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Operational health</p>
			<h1>Insights</h1>
			<p>Trends, comparisons, and locations that need attention.</p>
		</div>
	</header>

	<section>
		<div class="section-header"><h2>Today at a glance</h2></div>
		<div class="insight-metrics">
			<div class="insight-metric">
				<span>Attendance</span><strong>{data.trends.attendancePct.value}%</strong>
				<p>
					<AttendanceYesterdayIcon size={14} />
					{fmtDelta(data.trends.attendancePct.vsYesterday)}pp vs yesterday
				</p>
				<p>
					<AttendanceAverageIcon size={14} />
					{fmtDelta(data.trends.attendancePct.vs7dAvg)}pp vs 7-day average
				</p>
			</div>
			<div class="insight-metric">
				<span>Fraud flags</span><strong>{data.trends.fraudFlags.value}</strong>
				<p><FraudIcon size={14} /> {fmtDelta(data.trends.fraudFlags.vsYesterday)} vs yesterday</p>
			</div>
			<div class="insight-metric">
				<span>Active pumps</span><strong>{data.trends.activePumps.value}</strong>
				<p><PumpsIcon size={14} /> {fmtDelta(data.trends.activePumps.vsYesterday)} vs yesterday</p>
			</div>
		</div>
	</section>

	<section class="section">
		<div class="section-header">
			<div>
				<h2>Pumps needing attention</h2>
				<p class="supporting-text">
					Combined submission and attendance signals, highest priority first.
				</p>
			</div>
			<StatusBadge tone="attention" label={`${data.pumpsNeedingAttention.length} flagged`} />
		</div>
		{#if data.pumpsNeedingAttention.length}
			<div class="attention-list">
				{#each data.pumpsNeedingAttention as pump, index}
					<a href={resolve(`/admin/pumps/${pump.id}`)}>
						<span class="rank">{index + 1}</span>
						<span><strong>{pump.pump_code}</strong><small>{pump.reasons.join(' · ')}</small></span>
						<ArrowRight size={18} />
					</a>
				{/each}
			</div>
		{:else}
			<EmptyState
				title="No pumps need attention"
				description="Submission timing and attendance trends are within the expected range."
			/>
		{/if}
	</section>

	<section class="section">
		<div class="section-header">
			<div>
				<h2>Vendor rollup</h2>
				<p class="supporting-text">Ranked by change from the 30-day baseline.</p>
			</div>
		</div>
		<div class="table-wrap">
			<table class="data-table">
				<thead
					><tr
						><th>Vendor</th><th>Pumps</th><th>People</th><th>Today</th><th>30-day baseline</th><th
							>Change</th
						><th>Area median</th><th>Fraud rate</th><th>7-day trend</th></tr
					></thead
				>
				<tbody
					>{#each data.vendorRollup as vendor}{@const DeltaIcon = deltaIcon(vendor.delta)}<tr
							><td><a href={resolve(`/admin/vendors/${vendor.id}`)}>{vendor.name}</a></td><td
								>{vendor.pumpCount}</td
							><td>{vendor.distinctPersons}</td><td>{vendor.todayPct}%</td><td
								>{vendor.baselinePct}%</td
							><td><span class="delta"><DeltaIcon size={14} /> {fmtDelta(vendor.delta)}pp</span></td
							><td>{vendor.areaMedianPct}%</td><td>{vendor.fraudRate}%</td><td
								><Sparkline
									values={data.vendorSparklines[vendor.id] || []}
									width={100}
									height={24}
									label={`${vendor.name} seven-day trend`}
								/></td
							></tr
						>{/each}</tbody
				>
			</table>
		</div>
	</section>

	<section class="section">
		<div class="section-header">
			<div>
				<h2>Area rollup</h2>
				<p class="supporting-text">Attendance performance across operating areas.</p>
			</div>
		</div>
		<div class="table-wrap">
			<table class="data-table">
				<thead
					><tr
						><th>Area</th><th>Pumps</th><th>People</th><th>Today</th><th>30-day baseline</th><th
							>Change</th
						><th>7-day trend</th></tr
					></thead
				>
				<tbody
					>{#each data.areaRollup as area}{@const DeltaIcon = deltaIcon(area.delta)}<tr
							><td><a href={resolve(`/admin/areas/${area.id}`)}>{area.name}</a></td><td>{area.pumpCount}</td
							><td>{area.distinctPersons}</td><td>{area.todayPct}%</td><td>{area.baselinePct}%</td
							><td><span class="delta"><DeltaIcon size={14} /> {fmtDelta(area.delta)}pp</span></td
							><td
								><Sparkline
									values={data.areaSparklines[area.id] || []}
									width={100}
									height={24}
									label={`${area.name} seven-day trend`}
								/></td
							></tr
						>{/each}</tbody
				>
			</table>
		</div>
	</section>

	<section class="section quality-panel surface surface--padded">
		<div>
			<p class="eyebrow">Data quality</p>
			<h2>Guest review backlog</h2>
			<strong>{data.pendingGuestCount}</strong>
			<p>
				Unreviewed guest faces. A sustained increase may indicate that face-match thresholds need
				review.
			</p>
		</div>
		<Sparkline
			values={data.guestBacklogSeries}
			width={280}
			height={80}
			label="Seven-day guest review backlog"
		/>
	</section>
</div>

<style>
	.insights-page {
		--content-max: 88rem;
	}
	.eyebrow {
		margin: 0 0 var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
	}
	.insight-metrics {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-lg);
	}
	.insight-metric {
		padding: var(--space-5);
		border-right: 1px solid var(--brand-mist);
	}
	.insight-metric:last-child {
		border-right: 0;
	}
	.insight-metric > span {
		color: var(--ink-muted);
	}
	.insight-metric > strong {
		display: block;
		margin: var(--space-1) 0 var(--space-3);
		color: var(--ink-strong);
		font-size: var(--text-2xl);
	}
	.insight-metric p,
	.delta {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		margin: var(--space-1) 0;
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}
	.attention-list {
		overflow: hidden;
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-lg);
	}
	.attention-list a {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		color: var(--ink-default);
		text-decoration: none;
		border-bottom: 1px solid var(--brand-mist);
	}
	.attention-list a:last-child {
		border-bottom: 0;
	}
	.attention-list a:hover {
		background: var(--surface-subtle);
	}
	.attention-list a > span:nth-child(2) {
		display: grid;
	}
	.attention-list small {
		color: var(--ink-muted);
	}
	.rank {
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
	.quality-panel {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-6);
	}
	.quality-panel > div {
		max-width: 42rem;
	}
	.quality-panel h2 {
		margin-bottom: var(--space-1);
	}
	.quality-panel strong {
		color: var(--ink-strong);
		font-size: var(--text-3xl);
	}
	.quality-panel p:last-child {
		margin: var(--space-2) 0 0;
		color: var(--ink-muted);
	}
	@media (max-width: 48rem) {
		.insight-metrics {
			grid-template-columns: 1fr;
		}
		.insight-metric {
			border-right: 0;
			border-bottom: 1px solid var(--brand-mist);
		}
		.insight-metric:last-child {
			border-bottom: 0;
		}
		.quality-panel {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>
