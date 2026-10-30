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

<svelte:head><title>{data.plant.name} | Face Attendance</title></svelte:head>

<div class="page detail-page">
	<a class="back-link" href={resolve('/admin/plants')}><ArrowLeft size={16} /> Plants</a>
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">
				Plant in <a href={resolve('/admin/areas/[id]', { id: data.plant.area_id })}
					>{data.plant.area_name}</a
				>
			</p>
			<h1>{data.plant.name}</h1>
			<p>
				{#if data.plant.manager_name}Plant manager {data.plant
						.manager_name}{#if data.plant.manager_email}{' '}·
						{data.plant.manager_email}{/if}{:else}No plant manager yet{/if}
			</p>
		</div>
	</header>

	{#if data.summary}
		<section class="section" aria-labelledby="today-heading">
			<h2 id="today-heading">Today, {formatDate(data.today)}</h2>
			<TodayCards testId="plant-today" items={[data.summary]} />
		</section>
	{/if}

	<section class="section" aria-labelledby="pumps-heading">
		<h2 id="pumps-heading">Pumps <span class="count">{data.pumps.length}</span></h2>
		<PumpTodayList pumps={data.pumps} rangeLabel={data.range.label} />
	</section>

	<section class="section" aria-labelledby="calendar-heading">
		<div class="section-header">
			<div>
				<h2 id="calendar-heading">Attendance by pump</h2>
				<p class="supporting-text">Percent of workers with a full shift, per day.</p>
			</div>
		</div>
		<DateRangePicker bind:from bind:to onchange={apply} />
		<AttendanceCalendarGrid
			days={data.range.days}
			entities={data.pumps.map((pump) => ({ id: pump.id, label: pump.pumpCode }))}
			cellValue={(id: string, day: string) => data.daily[`${id}|${day}`] ?? null}
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
	.count {
		color: var(--ink-muted);
		font-size: var(--text-base);
		font-weight: 600;
	}
</style>
