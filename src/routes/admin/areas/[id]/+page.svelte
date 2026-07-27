<script lang="ts">
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

	const entities = $derived(data.plants.map((plant: any) => ({ id: plant.id, label: plant.name })));

	function apply() {
		window.location.search = new URLSearchParams({ from, to }).toString();
	}

	function cellValue(plantId: string, day: string) {
		const value = data.dailyMap[`${plantId}|${day}`];
		return !value || value.total === 0 ? null : Math.round((value.present / value.total) * 100);
	}
</script>

<svelte:head><title>{data.area.name} | Face Attendance</title></svelte:head>

<div class="page detail-page">
	<a class="back-link" href="/admin/attendance"><ArrowLeft size={16} /> Attendance records</a>
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Area</p>
			<h1>{data.area.name}</h1>
			<p>Plant-level attendance across the selected range.</p>
		</div>
	</header>
	<DateRangePicker bind:from bind:to onchange={apply} />
	<section class="section">
		<div class="section-header">
			<div>
				<h2>Attendance by plant</h2>
				<p class="supporting-text">Daily percentage of complete attendance.</p>
			</div>
		</div>
		<AttendanceCalendarGrid days={data.days} {entities} {cellValue} mode="percent" />
	</section>
	<section class="section">
		<div class="section-header"><h2>Plants</h2></div>
		<div class="table-wrap">
			<table class="data-table">
				<thead><tr><th>Plant</th><th>Attendance in range</th></tr></thead><tbody
					>{#each data.plants as plant}<tr
							><td><strong>{plant.name}</strong></td><td>{plant.attendancePct}%</td></tr
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
</style>
