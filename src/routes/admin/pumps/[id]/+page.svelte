<script lang="ts">
	import { formatDate } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import DateRangePicker from '$lib/components/DateRangePicker.svelte';
	import { sparklinePath } from '$lib/sparkline';

	let { data } = $props();
	let from = $state(data.range.from);
	let to = $state(data.range.to);

	function apply() {
		const params = new URLSearchParams({ from, to });
		window.location.search = params.toString();
	}

	const entities = data.roster.map((p: any) => ({
		id: p.id,
		label: personDisplayLabel(data.pump.pump_code, p.display_seq)
	}));

	function cellValue(personId: string, day: string) {
		return data.attendanceMap[`${personId}|${day}`] ?? 'absent';
	}
</script>

<div class="wrap">
	<a href="/admin/attendance">&larr; Back to Attendance Table</a>
	<h1>{data.pump.pump_code}</h1>
	<p class="header-info">
		<a href="/admin/vendors/{data.pump.vendor_id}">{data.pump.vendor_name}</a> ·
		{data.pump.plant_name} ·
		<a href="/admin/areas/{data.pump.area_id}">{data.pump.area_name}</a>
	</p>

	<DateRangePicker bind:from bind:to onchange={apply} />

	<h2>Attendance Trend (range)</h2>
	<svg width="200" height="30" viewBox="0 0 200 30">
		<path d={sparklinePath(data.sparkline, 200, 30)} fill="none" stroke="#2563eb" stroke-width="1.5" />
	</svg>
	<p class="rejection-summary">
		Morning sessions expired unpaired in range: {data.rejectionCounts.morningExpired}.
		<span class="muted">(9-hour-rule and duplicate-photo submissions are rejected before a session row
		is created, so they aren't retroactively queryable here — only the pump's live error response shows those.)</span>
	</p>

	<h2>Attendance Calendar</h2>
	<AttendanceCalendarGrid days={data.days} {entities} {cellValue} mode="status" />

	<h2>Session Log</h2>
	<table>
		<thead>
			<tr><th>Submitted At</th><th>Type</th><th>Status</th><th>Pairing</th><th>Error / Rejection</th></tr>
		</thead>
		<tbody>
			{#each data.sessionLog as s}
				<tr>
					<td>{formatDate(s.submitted_at)}</td>
					<td>{s.session_type}</td>
					<td>{s.status}</td>
					<td>{s.pairing_status}</td>
					<td>{s.error_reason || (s.pairing_status === 'expired' ? 'morning session expired unpaired' : '')}</td>
				</tr>
			{/each}
		</tbody>
	</table>

	<h2>Roster</h2>
	<table>
		<thead>
			<tr><th>Person</th><th>First Seen</th><th>Last Seen</th><th>Days Present</th><th>Morning Only</th><th>Evening Only</th></tr>
		</thead>
		<tbody>
			{#each data.roster as p}
				<tr>
					<td><a href="/admin/persons/{p.id}">{personDisplayLabel(data.pump.pump_code, p.display_seq)}</a></td>
					<td>{formatDate(p.first_seen_at)}</td>
					<td>{formatDate(p.last_seen_at)}</td>
					<td>{p.days_present}</td>
					<td>{p.days_morning_only}</td>
					<td>{p.days_evening_only}</td>
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
	.header-info {
		color: #555;
	}
	.muted {
		color: #888;
		font-size: 0.8rem;
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
