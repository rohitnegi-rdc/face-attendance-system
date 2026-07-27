<script lang="ts">
	import { sparklinePath } from '$lib/sparkline';

	let { data } = $props();

	function deltaClass(v: number) {
		return v > 0 ? 'delta-up' : v < 0 ? 'delta-down' : 'delta-flat';
	}
	function fmtDelta(v: number) {
		return v > 0 ? `+${v}` : `${v}`;
	}
</script>

<div class="wrap">
	<h1>Insights</h1>

	<section>
		<h2>Today at a Glance</h2>
		<div class="cards">
			<div class="card">
				<div class="label">Attendance %</div>
				<div class="value">{data.trends.attendancePct.value}%</div>
				<div class="delta {deltaClass(data.trends.attendancePct.vsYesterday)}">
					{fmtDelta(data.trends.attendancePct.vsYesterday)}pp vs yesterday
				</div>
				<div class="delta {deltaClass(data.trends.attendancePct.vs7dAvg)}">
					{fmtDelta(data.trends.attendancePct.vs7dAvg)}pp vs 7-day avg
				</div>
			</div>
			<div class="card">
				<div class="label">Fraud Flags Today</div>
				<div class="value">{data.trends.fraudFlags.value}</div>
				<div class="delta {deltaClass(data.trends.fraudFlags.vsYesterday)}">
					{fmtDelta(data.trends.fraudFlags.vsYesterday)} vs yesterday
				</div>
			</div>
			<div class="card">
				<div class="label">Active Pumps Today</div>
				<div class="value">{data.trends.activePumps.value}</div>
				<div class="delta {deltaClass(data.trends.activePumps.vsYesterday)}">
					{fmtDelta(data.trends.activePumps.vsYesterday)} vs yesterday
				</div>
			</div>
		</div>
	</section>

	<section>
		<h2>Pumps Needing Attention ({data.pumpsNeedingAttention.length})</h2>
		{#if data.pumpsNeedingAttention.length === 0}
			<p class="muted">No pumps currently flagged.</p>
		{:else}
			<ul class="attention-list">
				{#each data.pumpsNeedingAttention as p}
					<li>
						<a href="/admin/pumps/{p.id}">{p.pump_code}</a>
						<span class="reasons">{p.reasons.join('; ')}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section>
		<h2>Vendor Rollup</h2>
		<table>
			<thead>
				<tr>
					<th>Vendor</th><th>Pumps</th><th>Persons (30d)</th><th>Today %</th><th>30d Baseline</th>
					<th>Δ vs Baseline</th><th>Area Median</th><th>Fraud Rate</th><th>7d Trend</th>
				</tr>
			</thead>
			<tbody>
				{#each data.vendorRollup as v}
					<tr>
						<td><a href="/admin/vendors/{v.id}">{v.name}</a></td>
						<td>{v.pumpCount}</td>
						<td>{v.distinctPersons}</td>
						<td>{v.todayPct}%</td>
						<td>{v.baselinePct}%</td>
						<td class={deltaClass(v.delta)}>{fmtDelta(v.delta)}pp</td>
						<td>{v.areaMedianPct}%</td>
						<td>{v.fraudRate}%</td>
						<td>
							<svg width="100" height="24" viewBox="0 0 100 24">
								<path d={sparklinePath(data.vendorSparklines[v.id] || [])} fill="none" stroke="#2563eb" stroke-width="1.5" />
							</svg>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>

	<section>
		<h2>Area Rollup</h2>
		<table>
			<thead>
				<tr><th>Area</th><th>Pumps</th><th>Persons (30d)</th><th>Today %</th><th>30d Baseline</th><th>Δ vs Baseline</th><th>7d Trend</th></tr>
			</thead>
			<tbody>
				{#each data.areaRollup as a}
					<tr>
						<td><a href="/admin/areas/{a.id}">{a.name}</a></td>
						<td>{a.pumpCount}</td>
						<td>{a.distinctPersons}</td>
						<td>{a.todayPct}%</td>
						<td>{a.baselinePct}%</td>
						<td class={deltaClass(a.delta)}>{fmtDelta(a.delta)}pp</td>
						<td>
							<svg width="100" height="24" viewBox="0 0 100 24">
								<path d={sparklinePath(data.areaSparklines[a.id] || [])} fill="none" stroke="#2563eb" stroke-width="1.5" />
							</svg>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>

	<section>
		<h2>Data-Quality Backlog</h2>
		<p>Pending flagged guests: {data.pendingGuestCount}</p>
		<svg width="140" height="30" viewBox="0 0 140 30">
			<path d={sparklinePath(data.guestBacklogSeries, 140, 30)} fill="none" stroke="#dc2626" stroke-width="1.5" />
		</svg>
		<p class="muted">7-day trend of unreviewed flagged guests — a growing line may indicate FACE_MATCH_THRESHOLD needs retuning.</p>
	</section>
</div>

<style>
	.wrap {
		max-width: 1200px;
		margin: 2rem auto;
		font-family: sans-serif;
	}
	section {
		margin-bottom: 2rem;
	}
	.cards {
		display: flex;
		gap: 1rem;
	}
	.card {
		border: 1px solid #ddd;
		border-radius: 6px;
		padding: 0.75rem 1.25rem;
		min-width: 160px;
	}
	.card .label {
		font-size: 0.8rem;
		color: #666;
	}
	.card .value {
		font-size: 1.4rem;
		font-weight: 600;
	}
	.delta {
		font-size: 0.75rem;
	}
	.delta-up {
		color: #16a34a;
	}
	.delta-down {
		color: #dc2626;
	}
	.delta-flat {
		color: #666;
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	th,
	td {
		border: 1px solid #ddd;
		padding: 0.3rem 0.5rem;
	}
	.attention-list {
		list-style: none;
		padding: 0;
	}
	.attention-list li {
		padding: 0.4rem 0;
		border-bottom: 1px solid #eee;
	}
	.reasons {
		color: #666;
		font-size: 0.85rem;
		margin-left: 0.5rem;
	}
	.muted {
		color: #888;
		font-size: 0.85rem;
	}
</style>
