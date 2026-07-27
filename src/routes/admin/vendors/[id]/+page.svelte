<script lang="ts">
	import ArrowDownUp from '@lucide/svelte/icons/arrow-down-up';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import DateRangePicker from '$lib/components/DateRangePicker.svelte';

	let { data } = $props();
	let from = $state('');
	let to = $state('');
	let sortCol = $state<'pump_code' | 'attendancePct'>('pump_code');
	$effect(() => {
		if (!from) from = data.range.from;
		if (!to) to = data.range.to;
	});

	const entities = $derived(
		data.pumps.map((pump: any) => ({ id: pump.id, label: pump.pump_code }))
	);
	let sortedPumps = $derived(
		[...data.pumps].sort((a: any, b: any) =>
			sortCol === 'attendancePct'
				? b.attendancePct - a.attendancePct
				: a.pump_code.localeCompare(b.pump_code)
		)
	);

	function apply() {
		window.location.search = new URLSearchParams({ from, to }).toString();
	}

	function cellValue(pumpId: string, day: string) {
		const value = data.dailyMap[`${pumpId}|${day}`];
		return !value || value.total === 0 ? null : Math.round((value.present / value.total) * 100);
	}
</script>

<svelte:head><title>{data.vendor.name} | Face Attendance</title></svelte:head>

<div class="page detail-page">
	<a class="back-link" href="/admin/attendance"><ArrowLeft size={16} /> Attendance records</a>
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Vendor</p>
			<h1>{data.vendor.name}</h1>
			<p>Pump performance across the selected range.</p>
		</div>
	</header>
	<DateRangePicker bind:from bind:to onchange={apply} />
	<section class="section">
		<div class="section-header">
			<div>
				<h2>Attendance by pump</h2>
				<p class="supporting-text">Daily percentage of complete attendance.</p>
			</div>
		</div>
		<AttendanceCalendarGrid days={data.days} {entities} {cellValue} mode="percent" />
	</section>
	<section class="section">
		<div class="section-header"><h2>Pumps</h2></div>
		<div class="table-wrap">
			<table class="data-table">
				<thead
					><tr
						><th
							><button class="sort-button" type="button" onclick={() => (sortCol = 'pump_code')}
								>Pump <ArrowDownUp size={14} /></button
							></th
						><th>Plant</th><th>Area</th><th
							><button class="sort-button" type="button" onclick={() => (sortCol = 'attendancePct')}
								>Attendance <ArrowDownUp size={14} /></button
							></th
						></tr
					></thead
				><tbody
					>{#each sortedPumps as pump}<tr
							><td><a href={`/admin/pumps/${pump.id}`}>{pump.pump_code}</a></td><td
								>{pump.plant_name}</td
							><td>{pump.area_name}</td><td>{pump.attendancePct}%</td></tr
						>{/each}</tbody
				>
			</table>
		</div>
	</section>
</div>

<style>
	.detail-page {
		--content-max: 80rem;
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
	.sort-button {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 0;
		color: inherit;
		background: transparent;
		border: 0;
		font: inherit;
		font-weight: 700;
		cursor: pointer;
	}
</style>
