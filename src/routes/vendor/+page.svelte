<script lang="ts">
	import { formatDate } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';

	let { data } = $props();
</script>

<div class="wrap">
	<h1>Vendor Dashboard</h1>
	<h2>Your Pumps</h2>
	<table data-testid="vendor-pumps-table">
		<thead><tr><th>Pump Code</th><th>Plant</th><th>Area</th></tr></thead>
		<tbody>
			{#each data.pumps as p}
				<tr><td>{p.pump_code}</td><td>{p.plant_name}</td><td>{p.area_name}</td></tr>
			{/each}
		</tbody>
	</table>

	<h2>Auto-discovered Persons</h2>
	<table data-testid="vendor-persons-table">
		<thead><tr><th>Person</th><th>Pump</th><th>First Seen</th><th>Days Present</th></tr></thead>
		<tbody>
			{#each data.persons as p}
				<tr>
					<td>{personDisplayLabel(p.pump_code, p.display_seq)}</td>
					<td>{p.pump_code}</td>
					<td>{formatDate(p.first_seen_at)}</td>
					<td>{p.days_present}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.wrap {
		max-width: 900px;
		margin: 2rem auto;
		font-family: sans-serif;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		margin-bottom: 2rem;
	}
	th,
	td {
		border: 1px solid #ddd;
		padding: 0.4rem 0.6rem;
		text-align: left;
	}
</style>
