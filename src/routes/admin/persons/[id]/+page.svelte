<script lang="ts">
	import { formatDate } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';

	let { data } = $props();
</script>

<div class="wrap">
	<a href="/admin/pumps/{data.person.pump_id}">&larr; Back to {data.person.pump_code}</a>
	<h1>{personDisplayLabel(data.person.pump_code, data.person.display_seq)}</h1>
	<p>First seen: {formatDate(data.person.first_seen_at)} · Last seen: {formatDate(data.person.last_seen_at)} · Status: {data.person.status}</p>

	<h2>Yearly Rollup</h2>
	<table>
		<thead><tr><th>Year</th><th>Days Present</th><th>Morning Only</th><th>Evening Only</th></tr></thead>
		<tbody>
			{#each data.yearly as y}
				<tr><td>{y.year}</td><td>{y.days_present}</td><td>{y.days_morning_only}</td><td>{y.days_evening_only}</td></tr>
			{/each}
		</tbody>
	</table>

	<h2>Attendance History</h2>
	<table>
		<thead><tr><th>Date</th><th>Morning</th><th>Evening</th><th>Status</th></tr></thead>
		<tbody>
			{#each data.history as h}
				<tr>
					<td>{formatDate(h.session_date)}</td>
					<td>{h.morning_matched ? 'Yes' : 'No'}</td>
					<td>{h.evening_matched ? 'Yes' : 'No'}</td>
					<td>{h.morning_matched && h.evening_matched ? 'Present' : 'Absent'}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.wrap {
		max-width: 800px;
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
