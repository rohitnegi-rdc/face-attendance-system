<script lang="ts">
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import DateRangePicker from '$lib/components/DateRangePicker.svelte';

	let { data } = $props();
	let from = $state(data.range.from);
	let to = $state(data.range.to);
	let sortCol = $state<'pump_code' | 'attendancePct'>('pump_code');

	function apply() {
		const params = new URLSearchParams({ from, to });
		window.location.search = params.toString();
	}

	let sortedPumps = $derived(
		[...data.pumps].sort((a: any, b: any) =>
			sortCol === 'attendancePct' ? b.attendancePct - a.attendancePct : a.pump_code.localeCompare(b.pump_code)
		)
	);

	const entities = data.pumps.map((p: any) => ({ id: p.id, label: p.pump_code }));

	function cellValue(pumpId: string, day: string) {
		const v = data.dailyMap[`${pumpId}|${day}`];
		if (!v || v.total === 0) return null;
		return Math.round((v.present / v.total) * 100);
	}
</script>

<div class="wrap">
	<a href="/admin/attendance">&larr; Back to Attendance Table</a>
	<h1>{data.vendor.name}</h1>

	<DateRangePicker bind:from bind:to onchange={apply} />

	<h2>Attendance % by Pump (over range)</h2>
	<AttendanceCalendarGrid days={data.days} {entities} {cellValue} mode="percent" />

	<h2>Pumps</h2>
	<table>
		<thead>
			<tr>
				<th><button onclick={() => (sortCol = 'pump_code')}>Pump</button></th>
				<th>Plant</th>
				<th>Area</th>
				<th><button onclick={() => (sortCol = 'attendancePct')}>Attendance % (range)</button></th>
			</tr>
		</thead>
		<tbody>
			{#each sortedPumps as p}
				<tr>
					<td><a href="/admin/pumps/{p.id}">{p.pump_code}</a></td>
					<td>{p.plant_name}</td>
					<td>{p.area_name}</td>
					<td>{p.attendancePct}%</td>
				</tr>
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
	th button {
		background: none;
		border: none;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
		padding: 0;
	}
</style>
