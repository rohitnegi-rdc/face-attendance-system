<script lang="ts">
	import { formatDate } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';

	let { data } = $props();

	let expandedPumps = $state(new Set<string>());
	function toggle(pumpId: string) {
		if (expandedPumps.has(pumpId)) expandedPumps.delete(pumpId);
		else expandedPumps.add(pumpId);
		expandedPumps = new Set(expandedPumps);
	}

	function baseParams() {
		return Object.fromEntries(Object.entries(data.filters).filter(([, v]) => v));
	}

	function sortUrl(col: string) {
		const dir = data.sort.col === col && data.sort.dir === 'asc' ? 'desc' : 'asc';
		const params = new URLSearchParams({ ...baseParams(), sort: col, dir });
		return `?${params.toString()}`;
	}

	function pageUrl(page: number) {
		const params = new URLSearchParams({
			...baseParams(),
			sort: data.sort.col,
			dir: data.sort.dir,
			page: String(page)
		});
		return `?${params.toString()}`;
	}

	// group flat rows by area -> vendor -> pump for the grouped-view expandable rows
	function pumpRows(pumpId: string) {
		return data.rows.filter((r: any) => r.pump_id === pumpId);
	}

	let groupedByArea = $derived.by(() => {
		const areas = new Map<string, { name: string; vendors: Map<string, { name: string; pumps: any[] }> }>();
		for (const g of data.grouped) {
			if (!areas.has(g.area_id)) areas.set(g.area_id, { name: g.area_name, vendors: new Map() });
			const area = areas.get(g.area_id)!;
			if (!area.vendors.has(g.vendor_id)) area.vendors.set(g.vendor_id, { name: g.vendor_name, pumps: [] });
			area.vendors.get(g.vendor_id)!.pumps.push(g);
		}
		return areas;
	});
</script>

<div class="wrap">
	<h1>Attendance Table</h1>
	<form method="get">
		<select name="area" value={data.filters.area}>
			<option value="">All Areas</option>
			{#each data.options.areas as a}
				<option value={a.id} selected={a.id === data.filters.area}>{a.name}</option>
			{/each}
		</select>
		<select name="vendor" value={data.filters.vendor}>
			<option value="">All Vendors</option>
			{#each data.options.vendors as v}
				<option value={v.id} selected={v.id === data.filters.vendor}>{v.name}</option>
			{/each}
		</select>
		<select name="pump" value={data.filters.pump}>
			<option value="">All Pumps</option>
			{#each data.options.pumps as p}
				<option value={p.id} selected={p.id === data.filters.pump}>{p.pump_code}</option>
			{/each}
		</select>
		<label>
			Day:
			<input name="day" type="date" value={data.filters.day} />
		</label>
		<label>
			From:
			<input name="from" type="date" value={data.filters.from} />
		</label>
		<label>
			To:
			<input name="to" type="date" value={data.filters.to} />
		</label>
		<button type="submit">Filter</button>
	</form>
	<a
		href="/api/admin/attendance/export?{new URLSearchParams(
			Object.fromEntries(Object.entries(data.filters).filter(([, v]) => v))
		).toString()}">Export to Excel</a
	>

	<div class="summary-cards">
		<div class="card">
			<div class="label">Present</div>
			<div class="value">{data.summary.present}</div>
		</div>
		<div class="card">
			<div class="label">Absent</div>
			<div class="value">{data.summary.absent}</div>
		</div>
		<div class="card">
			<div class="label">Total</div>
			<div class="value">{data.summary.total}</div>
		</div>
		<div class="card">
			<div class="label">Attendance %</div>
			<div class="value">{data.summary.attendancePct}%</div>
		</div>
	</div>

	{#if data.isSingleDay}
		<div class="grouped-view">
			{#each groupedByArea as [areaId, area] (areaId)}
				<h3>{area.name}</h3>
				{#each area.vendors as [vendorId, vendor] (vendorId)}
					<h4><a href="/admin/vendors/{vendorId}">{vendor.name}</a></h4>
					<table class="pump-summary">
						<thead>
							<tr><th></th><th>Pump</th><th>Present</th><th>Absent</th><th>Total</th></tr>
						</thead>
						<tbody>
							{#each vendor.pumps as p}
								<tr>
									<td><button onclick={() => toggle(p.pump_id)}>{expandedPumps.has(p.pump_id) ? '−' : '+'}</button></td>
									<td><a href="/admin/pumps/{p.pump_id}">{p.pump_code}</a></td>
									<td>{p.present}</td>
									<td>{p.absent}</td>
									<td>{p.total}</td>
								</tr>
								{#if expandedPumps.has(p.pump_id)}
									<tr>
										<td colspan="5">
											<table class="person-detail">
												<thead><tr><th>Person</th><th>Status</th></tr></thead>
												<tbody>
													{#each pumpRows(p.pump_id) as r}
														<tr>
															<td>{personDisplayLabel(r.pump_code, r.display_seq)}</td>
															<td>{r.morning_matched && r.evening_matched ? 'Present' : 'Absent'}</td>
														</tr>
													{/each}
												</tbody>
											</table>
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				{/each}
			{/each}
		</div>
	{:else}
		<table data-testid="attendance-table">
			<thead>
				<tr>
					<th><a href={sortUrl('session_date')}>Date</a></th>
					<th>Person</th>
					<th><a href={sortUrl('pump_code')}>Pump</a></th>
					<th><a href={sortUrl('vendor_name')}>Vendor</a></th>
					<th>Plant</th>
					<th><a href={sortUrl('area_name')}>Area</a></th>
					<th><a href={sortUrl('status')}>Status</a></th>
				</tr>
			</thead>
			<tbody>
				{#each data.rows as r}
					<tr>
						<td>{formatDate(r.session_date)}</td>
						<td><a href="/admin/persons/{r.person_id}">{personDisplayLabel(r.pump_code, r.display_seq)}</a></td>
						<td><a href="/admin/pumps/{r.pump_id}">{r.pump_code}</a></td>
						<td><a href="/admin/vendors/{r.vendor_id}">{r.vendor_name}</a></td>
						<td>{r.plant_name}</td>
						<td><a href="/admin/areas/{r.area_id}">{r.area_name}</a></td>
						<td>{r.morning_matched && r.evening_matched ? 'Present' : 'Absent'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<div class="pager">
			{#if data.pagination.page > 1}
				<a href={pageUrl(data.pagination.page - 1)}>Prev</a>
			{/if}
			<span>Page {data.pagination.page} of {data.pagination.totalPages} ({data.pagination.total} rows)</span>
			{#if data.pagination.page < data.pagination.totalPages}
				<a href={pageUrl(data.pagination.page + 1)}>Next</a>
			{/if}
		</div>
	{/if}
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
		margin-top: 1rem;
	}
	th,
	td {
		border: 1px solid #ddd;
		padding: 0.3rem 0.5rem;
	}
	th a {
		color: inherit;
		text-decoration: none;
	}
	.summary-cards {
		display: flex;
		gap: 1rem;
		margin: 1rem 0;
	}
	.card {
		border: 1px solid #ddd;
		border-radius: 6px;
		padding: 0.75rem 1.25rem;
		min-width: 100px;
	}
	.card .label {
		font-size: 0.8rem;
		color: #666;
	}
	.card .value {
		font-size: 1.4rem;
		font-weight: 600;
	}
	.pager {
		display: flex;
		gap: 1rem;
		align-items: center;
		margin-top: 0.75rem;
	}
	.person-detail {
		margin: 0.25rem 0;
	}
	.grouped-view h3 {
		margin-bottom: 0.25rem;
	}
	.grouped-view h4 {
		margin: 0.5rem 0 0.25rem;
		font-size: 0.95rem;
	}
</style>
