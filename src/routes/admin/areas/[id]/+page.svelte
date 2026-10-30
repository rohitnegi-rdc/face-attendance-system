<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import DateRangePicker from '$lib/components/DateRangePicker.svelte';
	import PumpTodayList from '$lib/components/PumpTodayList.svelte';
	import TodayCards from '$lib/components/TodayCards.svelte';
	import { formatDate } from '$lib/date';

	let { data } = $props();
	let from = $state('');
	let to = $state('');
	$effect(() => {
		if (!from) from = data.range.from;
		if (!to) to = data.range.to;
	});
	function apply() {
		window.location.search = new URLSearchParams({ from, to }).toString();
	}
</script>

<svelte:head><title>{data.area.name} | Face Attendance</title></svelte:head>

<div class="page detail-page">
	<a class="back-link" href={resolve('/admin/areas')}><ArrowLeft size={16} /> Areas</a>
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Area</p>
			<h1>{data.area.name}</h1>
			<p>
				{data.plants.length}
				{data.plants.length === 1 ? 'plant' : 'plants'} · {data.pumps.length}
				{data.pumps.length === 1 ? 'pump' : 'pumps'}
			</p>
		</div>
	</header>

	<section class="section" aria-labelledby="plants-heading">
		<h2 id="plants-heading">Plants today, {formatDate(data.today)}</h2>
		<TodayCards
			testId="area-plants"
			items={data.plants.map((plant) => ({
				...plant,
				href: resolve('/admin/plants/[id]', { id: plant.id })
			}))}
		/>
	</section>

	<section class="section" aria-labelledby="pumps-heading">
		<h2 id="pumps-heading">Pumps <span class="count">{data.pumps.length}</span></h2>
		<PumpTodayList pumps={data.pumps} rangeLabel={data.range.label} showPlant />
	</section>

	<section class="section" aria-labelledby="calendar-heading">
		<div class="section-header">
			<div>
				<h2 id="calendar-heading">Attendance by day</h2>
				<p class="supporting-text">Percent of workers with a full shift, per day.</p>
			</div>
		</div>
		<DateRangePicker bind:from bind:to onchange={apply} />
		<h3>By plant</h3>
		<AttendanceCalendarGrid
			days={data.range.days}
			entities={data.plants.map((plant) => ({ id: plant.id, label: plant.name }))}
			cellValue={(id: string, day: string) => data.plantDaily[`${id}|${day}`] ?? null}
			mode="percent"
			entityLabel="Plant"
		/>
		<h3>By pump</h3>
		<AttendanceCalendarGrid
			days={data.range.days}
			entities={data.pumps.map((pump) => ({ id: pump.id, label: pump.pumpCode }))}
			cellValue={(id: string, day: string) => data.pumpDaily[`${id}|${day}`] ?? null}
			mode="percent"
			entityLabel="Pump"
		/>
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
		margin-bottom: var(--space-4);
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
	.section h2 {
		margin: 0 0 var(--space-3);
	}
	.section h3 {
		margin: var(--space-4) 0 var(--space-2);
		font-size: var(--text-base);
	}
	.count {
		color: var(--ink-muted);
		font-size: var(--text-base);
		font-weight: 600;
	}
</style>
