<script lang="ts">
	import Search from '@lucide/svelte/icons/search';
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { dateKey, formatDate } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';

	let { data } = $props();
	const days = $derived(
		[...new Set(data.daily.map((row: any) => dateKey(row.session_date)))].sort()
	);
	const entities = $derived(
		data.pumps
			.filter((pump: any) => !data.filters.pump || pump.id === data.filters.pump)
			.map((pump: any) => ({ id: pump.id, label: pump.pump_code }))
	);
	const lookup = $derived(
		new Map(
			data.daily.map((row: any) => [
				`${row.pump_id}:${dateKey(row.session_date)}`,
				Number(row.attendance_pct)
			])
		)
	);
</script>

<svelte:head><title>Vendor attendance | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Vendor workspace</p>
			<h1>Attendance</h1>
			<p>Compare daily outcomes and inspect person-level records.</p>
		</div>
	</header>

	<form class="filter-bar" method="GET">
		<label class="field"
			><span>Area</span><select name="area"
				><option value="">All areas</option>{#each data.areas as item}<option
						value={item.id}
						selected={item.id === data.filters.area}>{item.name}</option
					>{/each}</select
			></label
		>
		<label class="field"
			><span>Plant</span><select name="plant"
				><option value="">All plants</option>{#each data.plants as item}<option
						value={item.id}
						selected={item.id === data.filters.plant}>{item.name}</option
					>{/each}</select
			></label
		>
		<label class="field"
			><span>Pump</span><select name="pump"
				><option value="">All pumps</option>{#each data.pumps as item}<option
						value={item.id}
						selected={item.id === data.filters.pump}>{item.pump_code}</option
					>{/each}</select
			></label
		>
		<label class="field"
			><span>From</span><input type="date" name="from" value={data.filters.from} /></label
		>
		<label class="field"
			><span>To</span><input type="date" name="to" value={data.filters.to} /></label
		>
		<div class="filter-actions">
			<button class="button button--primary" type="submit"><Search size={17} /> Apply</button>
		</div>
	</form>

	<section class="section">
		<div class="section-header">
			<div>
				<h2>Daily calendar</h2>
				<p class="supporting-text">Attendance percentage by assigned pump.</p>
			</div>
		</div>
		{#if days.length}
			<AttendanceCalendarGrid
				{days}
				{entities}
				mode="percent"
				cellValue={(entity, day) => lookup.get(`${entity}:${day}`) ?? null}
			/>
		{:else}
			<EmptyState
				title="No attendance in this range"
				description="Adjust the date or location filters to view records."
			/>
		{/if}
	</section>

	<section class="section">
		<div class="section-header">
			<div>
				<h2>Person records</h2>
				<p class="supporting-text">{data.records.length} records shown</p>
			</div>
		</div>
		<div class="table-wrap">
			<table class="data-table">
				<thead
					><tr
						><th>Date</th><th>Person</th><th>Pump</th><th>Plant</th><th>Morning</th><th>Evening</th
						></tr
					></thead
				>
				<tbody
					>{#each data.records as row}<tr
							><td>{formatDate(row.session_date)}</td><td
								>{personDisplayLabel(row.pump_code, row.display_seq)}</td
							><td>{row.pump_code}</td><td>{row.plant_name}</td><td
								><StatusBadge
									tone={row.morning_matched ? 'success' : 'neutral'}
									label={row.morning_matched ? 'Matched' : 'Missing'}
								/></td
							><td
								><StatusBadge
									tone={row.evening_matched ? 'success' : 'neutral'}
									label={row.evening_matched ? 'Matched' : 'Missing'}
								/></td
							></tr
						>{/each}</tbody
				>
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
</style>
