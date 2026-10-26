<script lang="ts">
	import { resolve } from '$app/paths';
	import Download from '@lucide/svelte/icons/download';
	import Search from '@lucide/svelte/icons/search';
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import FacePeek from '$lib/components/FacePeek.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { calendarDays, dateKey, formatDate, todayStr } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';

	let { data } = $props();
	const days = $derived(calendarDays(data.filters.from, data.filters.to));
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
		<!-- Same reports as the plant manager, for this vendor's pumps (payroll, billing). -->
		<div class="header-actions">
			<a
				class="button button--secondary"
				href={resolve(
					`/vendor/attendance/export?${new URLSearchParams({ from: data.filters.from, to: data.filters.to })}`
				)}
				data-sveltekit-reload
				data-testid="vendor-export"
			>
				<Download size={17} /> Export report
			</a>
			<form
				class="headcount-form"
				method="GET"
				action={resolve('/vendor/attendance/export')}
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
		{#if data.daily.length}
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
					><tr><th>Date</th><th>Person</th><th>Pump</th><th>Plant</th><th>Start</th><th>End</th></tr
					></thead
				>
				<tbody
					>{#each data.records as row}<tr
							><td>{formatDate(row.session_date)}</td><td
								><span class="worker-tag"
									><FacePeek
										url={resolve('/api/persons/[id]/face', { id: row.person_id })}
										label={personDisplayLabel(row.pump_code, row.display_seq, row.is_operator, row.name)}
									/>{personDisplayLabel(row.pump_code, row.display_seq, row.is_operator, row.name)}</span
								></td
							><td>{row.pump_code}</td><td>{row.plant_name}</td><td
								><StatusBadge
									tone={row.morning_matched ? 'success' : 'neutral'}
									label={row.morning_matched ? 'Present' : 'Missing'}
								/></td
							><td
								><StatusBadge
									tone={row.evening_matched ? 'success' : 'neutral'}
									label={row.evening_matched ? 'Present' : 'Missing'}
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
