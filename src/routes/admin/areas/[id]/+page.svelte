<script lang="ts">
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import DateRangePicker from '$lib/components/DateRangePicker.svelte';

	let { data } = $props();
	let from = $state(data.range.from);
	let to = $state(data.range.to);

	function apply() {
		const params = new URLSearchParams({ from, to });
		window.location.search = params.toString();
	}

	const entities = data.plants.map((p: any) => ({ id: p.id, label: p.name }));

	function cellValue(plantId: string, day: string) {
		const v = data.dailyMap[`${plantId}|${day}`];
		if (!v || v.total === 0) return null;
		return Math.round((v.present / v.total) * 100);
	}
</script>

<div class="wrap">
	<a href="/admin/attendance">&larr; Back to Attendance Table</a>
	<h1>{data.area.name}</h1>

	<DateRangePicker bind:from bind:to onchange={apply} />

	<h2>Attendance % by Plant (over range)</h2>
	<AttendanceCalendarGrid days={data.days} {entities} {cellValue} mode="percent" />

	<h2>Plants</h2>
	<table>
		<thead><tr><th>Plant</th><th>Attendance % (range)</th></tr></thead>
		<tbody>
			{#each data.plants as p}
				<tr><td>{p.name}</td><td>{p.attendancePct}%</td></tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.wrap {
		max-width: 1100px;
		margin: 2rem auto;
		font-family: sans-serif;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		margin: 0.5rem 0 1.5rem;
	}
	th,
	td {
		border: 1px solid #ddd;
		padding: 0.3rem 0.5rem;
	}
</style>
