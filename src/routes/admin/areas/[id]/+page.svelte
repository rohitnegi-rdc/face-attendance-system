<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import DateRangePicker from '$lib/components/DateRangePicker.svelte';

	let { data } = $props();
	let from = $state('');
	let to = $state('');
	$effect(() => {
		if (!from) from = data.range.from;
		if (!to) to = data.range.to;
	});

	const plantEntities = $derived(
		data.plants.map((plant: any) => ({ id: plant.id, label: plant.name }))
	);
	const pumpEntities = $derived(
		data.pumps.map((pump: any) => ({ id: pump.id, label: pump.pump_code }))
	);

	function apply() {
		window.location.search = new URLSearchParams({ from, to }).toString();
	}

	function plantCellValue(plantId: string, day: string) {
		const value = data.plantDailyMap[`${plantId}|${day}`];
		return !value || value.total === 0 ? null : Math.round((value.present / value.total) * 100);
	}
	function pumpCellValue(pumpId: string, day: string) {
		const value = data.pumpDailyMap[`${pumpId}|${day}`];
		return !value || value.total === 0 ? null : Math.round((value.present / value.total) * 100);
	}
	function pageUrl(param: string, page: number) {
		const params = new URLSearchParams(window.location.search);
		params.set(param, String(page));
		return `?${params.toString()}`;
	}
</script>

<svelte:head><title>{data.area.name} | Face Attendance</title></svelte:head>

<div class="page detail-page">
	<a class="back-link" href={resolve('/admin/attendance')}><ArrowLeft size={16} /> Attendance records</a>
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Area</p>
			<h1>{data.area.name}</h1>
			<p>Plant- and pump-level attendance across the selected range.</p>
		</div>
	</header>
	<DateRangePicker bind:from bind:to onchange={apply} />

	<section class="section">
		<div class="section-header">
			<div>
				<h2>Attendance by plant</h2>
				<p class="supporting-text">
					Daily percentage of complete attendance &middot; scroll for more days.
				</p>
			</div>
		</div>
		<div class="calendar-frame">
			<AttendanceCalendarGrid
				days={data.days}
				entities={plantEntities}
				cellValue={plantCellValue}
				mode="percent"
				entityLabel="Plant"
			/>
		</div>
	</section>
	<section class="section">
		<div class="section-header"><h2>Plants</h2></div>
		<div class="table-wrap">
			<table class="data-table">
				<thead><tr><th>Plant</th><th>Manager</th><th>Attendance in range</th></tr></thead><tbody
					>{#each data.plants as plant}<tr
							><td><strong>{plant.name}</strong></td><td
								>{#if plant.manager_email}{plant.manager_name} · {plant.manager_email}{:else}—{/if}</td
							><td>{plant.attendancePct}%</td></tr
						>{/each}</tbody
				>
			</table>
		</div>
		{#if data.plantPagination.totalPages > 1}
			<nav class="pager" aria-label="Plants pagination">
				{#if data.plantPagination.page > 1}<a
						class="button button--secondary"
						href={pageUrl('plant_page', data.plantPagination.page - 1)}>Previous</a
					>{:else}<span></span>{/if}
				<span>Page {data.plantPagination.page} of {data.plantPagination.totalPages}</span>
				{#if data.plantPagination.page < data.plantPagination.totalPages}<a
						class="button button--secondary"
						href={pageUrl('plant_page', data.plantPagination.page + 1)}>Next</a
					>{/if}
			</nav>
		{/if}
	</section>

	<section class="section">
		<div class="section-header">
			<div>
				<h2>Attendance by pump</h2>
				<p class="supporting-text">
					Daily percentage of complete attendance &middot; scroll for more days.
				</p>
			</div>
		</div>
		<div class="calendar-frame">
			<AttendanceCalendarGrid
				days={data.days}
				entities={pumpEntities}
				cellValue={pumpCellValue}
				mode="percent"
				entityLabel="Pump"
			/>
		</div>
	</section>
	<section class="section">
		<div class="section-header"><h2>Pumps</h2></div>
		<div class="table-wrap">
			<table class="data-table">
				<thead><tr><th>Pump</th><th>Plant</th><th>Attendance in range</th></tr></thead><tbody
					>{#each data.pumps as pump}<tr
							><td><a href={resolve(`/admin/pumps/${pump.id}`)}>{pump.pump_code}</a></td><td
								>{pump.plant_name}</td
							><td>{pump.attendancePct}%</td></tr
						>{/each}</tbody
				>
			</table>
		</div>
		{#if data.pumpPagination.totalPages > 1}
			<nav class="pager" aria-label="Pumps pagination">
				{#if data.pumpPagination.page > 1}<a
						class="button button--secondary"
						href={pageUrl('pump_page', data.pumpPagination.page - 1)}>Previous</a
					>{:else}<span></span>{/if}
				<span>Page {data.pumpPagination.page} of {data.pumpPagination.totalPages}</span>
				{#if data.pumpPagination.page < data.pumpPagination.totalPages}<a
						class="button button--secondary"
						href={pageUrl('pump_page', data.pumpPagination.page + 1)}>Next</a
					>{/if}
			</nav>
		{/if}
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
</style>
