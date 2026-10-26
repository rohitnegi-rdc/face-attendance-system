<script lang="ts">
	import { resolve } from '$app/paths';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDateTime } from '$lib/date';
	let { data } = $props();

	const pumpsPath = resolve('/admin/pumps');
	function pageUrl(page: number) {
		const params = new URLSearchParams();
		if (data.q) params.set('q', data.q);
		if (page > 1) params.set('page', String(page));
		const search = params.toString();
		return search ? `${pumpsPath}?${search}` : pumpsPath;
	}
</script>

<svelte:head><title>Pumps | Face Attendance</title></svelte:head>
<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<h1>Pumps</h1>
			<p>
				Find a pump by its code, plant, area, vendor or login. Open it for the attendance calendar,
				the session log, fixes and Clear test records.
			</p>
		</div>
	</header>

	<form class="filter-bar pump-search" method="GET" role="search">
		<label class="field"
			><span>Search</span><input
				name="q"
				type="search"
				value={data.q}
				placeholder="e.g. AYLPADA1, Anjanapura, RDC"
				autocomplete="off"
				data-testid="pump-search"
			/></label
		>
		<div class="filter-actions">
			<button class="button button--primary" type="submit">Search</button>
			{#if data.q}<a class="button button--ghost" href={pumpsPath}>Clear</a>{/if}
		</div>
	</form>

	<p class="muted" data-testid="pump-total">
		{data.pagination.total}
		{data.pagination.total === 1 ? 'pump' : 'pumps'}{data.q ? ` matching "${data.q}"` : ''}
	</p>

	{#if data.pumps.length}
		<div class="table-wrap">
			<table class="data-table" data-testid="admin-pump-list">
				<thead>
					<tr>
						<th>Pump</th><th>Vendor</th><th>Plant</th><th>Area</th><th>People</th><th>Last photo</th
						><th>Status</th>
					</tr>
				</thead>
				<tbody>
					{#each data.pumps as pump (pump.id)}
						<tr>
							<td
								><a href={resolve('/admin/pumps/[id]', { id: pump.id })} title={pump.login_email}
									><strong>{pump.pump_code}</strong></a
								></td
							>
							<td>{pump.vendor_name}</td>
							<td>{pump.plant_name}</td>
							<td>{pump.area_name}</td>
							<td class="num">{pump.people}</td>
							<td>{pump.last_photo_at ? formatDateTime(pump.last_photo_at) : 'No photos yet'}</td>
							<td
								><StatusBadge
									tone={pump.status === 'active' ? 'success' : 'critical'}
									label={pump.status === 'active' ? 'Active' : 'Disabled'}
								/></td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if data.pagination.totalPages > 1}
			<nav class="pager" aria-label="Pump pages">
				{#if data.pagination.page > 1}
					<a class="button button--secondary" href={pageUrl(data.pagination.page - 1)}>Previous</a>
				{/if}
				<span>Page {data.pagination.page} of {data.pagination.totalPages}</span>
				{#if data.pagination.page < data.pagination.totalPages}
					<a class="button button--secondary" href={pageUrl(data.pagination.page + 1)}>Next</a>
				{/if}
			</nav>
		{/if}
	{:else}
		<EmptyState
			title={data.q ? 'No pump matches' : 'No pumps yet'}
			description={data.q
				? 'Check the spelling, or search by plant, area or vendor instead.'
				: 'Pumps are added on the Imports page.'}
		/>
	{/if}
</div>

<style>
	.pump-search {
		grid-template-columns: minmax(0, 28rem) auto;
		align-items: end;
	}
	.muted {
		margin: var(--space-3) 0;
		color: var(--ink-muted);
	}
	.num {
		font-variant-numeric: tabular-nums;
	}
	.data-table td {
		white-space: nowrap;
	}
	.pager {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin-top: var(--space-4);
	}
	@media (max-width: 30rem) {
		.pump-search {
			grid-template-columns: 1fr;
		}
	}
</style>
