<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import MetricStrip from '$lib/components/MetricStrip.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/date';

	let { data } = $props();
	const metrics = $derived([
		{ label: '30-day attendance', value: `${data.summary.attendance_pct}%` },
		{ label: 'Assigned pumps', value: data.summary.active_pumps },
		{ label: 'Known people', value: data.summary.known_people },
		{ label: 'Incomplete sessions', value: data.summary.incomplete_sessions }
	]);
</script>

<svelte:head><title>Vendor overview | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Vendor workspace</p>
			<h1>Overview</h1>
			<p>Attendance and submission health across your assigned pumps.</p>
		</div>
		<a class="button button--primary" href={resolve('/vendor/attendance')}
			>View attendance <ArrowRight size={17} /></a
		>
	</header>

	<MetricStrip {metrics} />

	<section class="section surface surface--padded trend">
		<div class="section-header">
			<div>
				<h2>Thirty-day attendance</h2>
				<p class="supporting-text">Complete morning and evening matches.</p>
			</div>
			<strong>{data.trend.at(-1)?.attendance_pct || 0}%</strong>
		</div>
		<Sparkline
			values={data.trend.map((day: any) => Number(day.attendance_pct))}
			width={900}
			height={100}
			label="Thirty-day vendor attendance"
		/>
	</section>

	<section class="section">
		<div class="section-header">
			<div>
				<h2>Pump activity</h2>
				<p class="supporting-text">Pumps needing attention appear first.</p>
			</div>
			<a href={resolve('/vendor/pumps')}>All pumps</a>
		</div>
		<div class="table-wrap">
			<table class="data-table" data-testid="vendor-pumps-table">
				<thead
					><tr
						><th>Pump</th><th>Plant</th><th>Area</th><th>Last submission</th><th>30-day rate</th><th
							>Status</th
						></tr
					></thead
				>
				<tbody>
					{#each data.pumps.slice(0, 10) as pump}
						<tr>
							<td><strong>{pump.pump_code}</strong></td>
							<td>{pump.plant_name}</td>
							<td>{pump.area_name}</td>
							<td
								>{pump.latest_submission
									? formatDate(pump.latest_submission)
									: 'No submissions'}</td
							>
							<td>{pump.attendance_pct}%</td>
							<td
								><StatusBadge
									tone={pump.latest_status === 'completed'
										? 'success'
										: pump.latest_status === 'failed'
											? 'critical'
											: 'pending'}
									label={pump.latest_status || 'Not started'}
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
	.trend :global(.sparkline) {
		width: 100%;
		height: 6rem;
		margin-top: var(--space-5);
	}
	.trend .section-header strong {
		color: var(--ink-strong);
		font-size: var(--text-2xl);
	}
</style>
