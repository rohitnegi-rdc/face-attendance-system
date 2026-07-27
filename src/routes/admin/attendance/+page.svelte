<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Download from '@lucide/svelte/icons/download';
	import Search from '@lucide/svelte/icons/search';
	import MetricStrip from '$lib/components/MetricStrip.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';

	let { data } = $props();
	let expandedPumps = $state(new Set<string>());

	const metrics = $derived([
		{ label: 'Present', value: data.summary.present },
		{ label: 'Absent', value: data.summary.absent },
		{ label: 'Records', value: data.summary.total },
		{ label: 'Attendance', value: `${data.summary.attendancePct}%` }
	]);

	function toggle(pumpId: string) {
		if (expandedPumps.has(pumpId)) expandedPumps.delete(pumpId);
		else expandedPumps.add(pumpId);
		expandedPumps = new Set(expandedPumps);
	}

	function baseParams() {
		return Object.fromEntries(Object.entries(data.filters).filter(([, value]) => value));
	}

	function sortUrl(column: string) {
		const dir = data.sort.col === column && data.sort.dir === 'asc' ? 'desc' : 'asc';
		return `?${new URLSearchParams({ ...baseParams(), sort: column, dir }).toString()}`;
	}

	function pageUrl(page: number) {
		return `?${new URLSearchParams({
			...baseParams(),
			sort: data.sort.col,
			dir: data.sort.dir,
			page: String(page)
		}).toString()}`;
	}

	function pumpRows(pumpId: string) {
		return data.rows.filter((row: any) => row.pump_id === pumpId);
	}

	function isPresent(row: any) {
		if (data.filters.session === 'morning') return row.morning_matched;
		if (data.filters.session === 'evening') return row.evening_matched;
		return row.morning_matched && row.evening_matched;
	}

	let groupedByArea = $derived.by(() => {
		const areas = new Map<
			string,
			{ name: string; vendors: Map<string, { name: string; pumps: any[] }> }
		>();
		for (const group of data.grouped) {
			if (!areas.has(group.area_id))
				areas.set(group.area_id, { name: group.area_name, vendors: new Map() });
			const area = areas.get(group.area_id)!;
			if (!area.vendors.has(group.vendor_id))
				area.vendors.set(group.vendor_id, { name: group.vendor_name, pumps: [] });
			area.vendors.get(group.vendor_id)!.pumps.push(group);
		}
		return areas;
	});

	const exportQuery = $derived(new URLSearchParams(baseParams()).toString());
</script>

<svelte:head><title>Attendance records | Face Attendance</title></svelte:head>

<div class="page attendance-page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Operations</p>
			<h1>Attendance records</h1>
			<p>Filter daily outcomes, inspect grouped attendance, and export the same result set.</p>
		</div>
		<a class="button button--secondary" href={`/api/admin/attendance/export?${exportQuery}`}>
			<Download size={17} /> Export XLSX
		</a>
	</header>

	<form class="filter-bar" method="GET">
		<label class="field"
			><span>Area</span><select name="area"
				><option value="">All areas</option>{#each data.options.areas as item}<option
						value={item.id}
						selected={item.id === data.filters.area}>{item.name}</option
					>{/each}</select
			></label
		>
		<label class="field"
			><span>Vendor</span><select name="vendor"
				><option value="">All vendors</option>{#each data.options.vendors as item}<option
						value={item.id}
						selected={item.id === data.filters.vendor}>{item.name}</option
					>{/each}</select
			></label
		>
		<label class="field"
			><span>Plant</span><select name="plant"
				><option value="">All plants</option>{#each data.options.plants as item}<option
						value={item.id}
						selected={item.id === data.filters.plant}>{item.name}</option
					>{/each}</select
			></label
		>
		<label class="field"
			><span>Pump</span><select name="pump"
				><option value="">All pumps</option>{#each data.options.pumps as item}<option
						value={item.id}
						selected={item.id === data.filters.pump}>{item.pump_code}</option
					>{/each}</select
			></label
		>
		<label class="field"
			><span>Session</span><select name="session"
				><option value="">Full day</option><option
					value="morning"
					selected={data.filters.session === 'morning'}>Morning</option
				><option value="evening" selected={data.filters.session === 'evening'}>Evening</option
				></select
			></label
		>
		<label class="field"
			><span>Status</span><select name="status"
				><option value="">Any status</option><option
					value="present"
					selected={data.filters.status === 'present'}>Present</option
				><option value="absent" selected={data.filters.status === 'absent'}>Absent</option></select
			></label
		>
		<label class="field"
			><span>Single day</span><input name="day" type="date" value={data.filters.day} /></label
		>
		<label class="field"
			><span>From</span><input name="from" type="date" value={data.filters.from} /></label
		>
		<label class="field"
			><span>To</span><input name="to" type="date" value={data.filters.to} /></label
		>
		<label class="field"
			><span>Rows</span><select name="page_size"
				><option value="25" selected={data.pagination.pageSize === 25}>25</option><option
					value="50"
					selected={data.pagination.pageSize === 50}>50</option
				><option value="100" selected={data.pagination.pageSize === 100}>100</option></select
			></label
		>
		<div class="filter-actions">
			<button class="button button--primary" type="submit"><Search size={17} /> Apply</button>
			<a class="button button--quiet" href="/admin/attendance">Clear</a>
		</div>
	</form>

	<div class="section"><MetricStrip {metrics} /></div>

	{#if data.isSingleDay}
		<section class="section grouped-view">
			<div class="section-header">
				<div>
					<h2>Grouped daily summary</h2>
					<p class="supporting-text">
						Area, vendor, and pump totals for {formatDate(data.filters.day)}.
					</p>
				</div>
			</div>
			{#each groupedByArea as [areaId, area] (areaId)}
				<div class="area-group">
					<h3><a href={`/admin/areas/${areaId}`}>{area.name}</a></h3>
					{#each area.vendors as [vendorId, vendor] (vendorId)}
						<div class="vendor-group">
							<h4><a href={`/admin/vendors/${vendorId}`}>{vendor.name}</a></h4>
							<div class="table-wrap">
								<table class="data-table pump-summary">
									<thead
										><tr
											><th><span class="sr-only">Expand</span></th><th>Pump</th><th>Present</th><th
												>Absent</th
											><th>Total</th></tr
										></thead
									>
									<tbody>
										{#each vendor.pumps as pump}
											<tr>
												<td
													><button
														class="icon-button expand-button"
														type="button"
														onclick={() => toggle(pump.pump_id)}
														aria-expanded={expandedPumps.has(pump.pump_id)}
														aria-label={`${expandedPumps.has(pump.pump_id) ? 'Collapse' : 'Expand'} ${pump.pump_code}`}
														><ChevronDown size={18} /></button
													></td
												>
												<td><a href={`/admin/pumps/${pump.pump_id}`}>{pump.pump_code}</a></td>
												<td>{pump.present}</td><td>{pump.absent}</td><td>{pump.total}</td>
											</tr>
											{#if expandedPumps.has(pump.pump_id)}
												<tr class="detail-row"
													><td colspan="5"
														><div class="person-records">
															{#each pumpRows(pump.pump_id) as row}<a
																	href={`/admin/persons/${row.person_id}`}
																	><span>{personDisplayLabel(row.pump_code, row.display_seq)}</span
																	><StatusBadge
																		tone={isPresent(row) ? 'success' : 'neutral'}
																		label={isPresent(row) ? 'Present' : 'Absent'}
																	/></a
																>{/each}
														</div></td
													></tr
												>
											{/if}
										{/each}
									</tbody>
								</table>
							</div>
						</div>
					{/each}
				</div>
			{/each}
		</section>
	{:else}
		<section class="section">
			<div class="section-header">
				<div>
					<h2>Records</h2>
					<p class="supporting-text">{data.pagination.total} matching rows</p>
				</div>
			</div>
			<div class="table-wrap desktop-table">
				<table class="data-table" data-testid="attendance-table">
					<thead
						><tr
							><th><a href={sortUrl('session_date')}>Date</a></th><th>Person</th><th
								><a href={sortUrl('pump_code')}>Pump</a></th
							><th><a href={sortUrl('vendor_name')}>Vendor</a></th><th>Plant</th><th
								><a href={sortUrl('area_name')}>Area</a></th
							><th><a href={sortUrl('status')}>Status</a></th></tr
						></thead
					>
					<tbody
						>{#each data.rows as row}<tr
								><td>{formatDate(row.session_date)}</td><td
									><a href={`/admin/persons/${row.person_id}`}
										>{personDisplayLabel(row.pump_code, row.display_seq)}</a
									></td
								><td><a href={`/admin/pumps/${row.pump_id}`}>{row.pump_code}</a></td><td
									><a href={`/admin/vendors/${row.vendor_id}`}>{row.vendor_name}</a></td
								><td>{row.plant_name}</td><td
									><a href={`/admin/areas/${row.area_id}`}>{row.area_name}</a></td
								><td
									><StatusBadge
										tone={isPresent(row) ? 'success' : 'neutral'}
										label={isPresent(row) ? 'Present' : 'Absent'}
									/></td
								></tr
							>{/each}</tbody
					>
				</table>
			</div>
			<div class="mobile-records">
				{#each data.rows as row}
					<article class="mobile-record">
						<div>
							<a href={`/admin/persons/${row.person_id}`}
								>{personDisplayLabel(row.pump_code, row.display_seq)}</a
							><StatusBadge
								tone={isPresent(row) ? 'success' : 'neutral'}
								label={isPresent(row) ? 'Present' : 'Absent'}
							/>
						</div>
						<dl>
							<div>
								<dt>Date</dt>
								<dd>{formatDate(row.session_date)}</dd>
							</div>
							<div>
								<dt>Pump</dt>
								<dd><a href={`/admin/pumps/${row.pump_id}`}>{row.pump_code}</a></dd>
							</div>
							<div>
								<dt>Vendor</dt>
								<dd>{row.vendor_name}</dd>
							</div>
							<div>
								<dt>Location</dt>
								<dd>{row.plant_name}, {row.area_name}</dd>
							</div>
						</dl>
					</article>
				{/each}
			</div>
			<nav class="pager" aria-label="Attendance pagination">
				{#if data.pagination.page > 1}<a
						class="button button--secondary"
						href={pageUrl(data.pagination.page - 1)}>Previous</a
					>{:else}<span></span>{/if}
				<span>Page {data.pagination.page} of {data.pagination.totalPages}</span>
				{#if data.pagination.page < data.pagination.totalPages}<a
						class="button button--secondary"
						href={pageUrl(data.pagination.page + 1)}>Next</a
					>{/if}
			</nav>
		</section>
	{/if}
</div>

<style>
	.eyebrow {
		margin: 0 0 var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
	}
	.attendance-page {
		--content-max: 88rem;
	}
	.area-group {
		margin-top: var(--space-5);
	}
	.area-group > h3 {
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--brand-mist);
	}
	.vendor-group {
		margin: var(--space-4) 0 var(--space-6);
	}
	.vendor-group h4 {
		margin-bottom: var(--space-2);
	}
	.expand-button {
		transition: transform var(--duration-fast) var(--ease-out);
	}
	.expand-button[aria-expanded='true'] {
		transform: rotate(180deg);
	}
	.detail-row td {
		padding: 0;
		background: var(--surface-subtle);
	}
	.person-records {
		display: grid;
		padding: var(--space-2) var(--space-6);
	}
	.person-records a {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-2);
		text-decoration: none;
		border-bottom: 1px solid var(--brand-mist);
	}
	.person-records a:last-child {
		border-bottom: 0;
	}
	.mobile-record {
		padding: var(--space-4);
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.mobile-record > div {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.mobile-record dl {
		display: grid;
		gap: var(--space-2);
		margin: var(--space-4) 0 0;
	}
	.mobile-record dl div {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
	}
	.mobile-record dt {
		color: var(--ink-muted);
	}
	.mobile-record dd {
		margin: 0;
		text-align: right;
	}
</style>
