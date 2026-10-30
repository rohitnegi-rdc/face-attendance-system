<script lang="ts">
	import { resolve } from '$app/paths';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import TodayCards from '$lib/components/TodayCards.svelte';
	import { formatDate } from '$lib/date';

	let { data } = $props();

	const areasPath = resolve('/admin/areas');
</script>

<svelte:head><title>Areas | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<h1>Areas</h1>
			<p>Today, {formatDate(data.today)}. Open an area for its plants, pumps and calendars.</p>
		</div>
	</header>

	<form class="filter-bar area-search" method="GET" role="search">
		<label class="field"
			><span>Search</span><input
				name="q"
				type="search"
				value={data.q}
				placeholder="Area or plant name"
				autocomplete="off"
				data-testid="area-search"
			/></label
		>
		<div class="filter-actions">
			<button class="button button--primary" type="submit">Search</button>
			{#if data.q}<a class="button button--ghost" href={areasPath}>Clear</a>{/if}
		</div>
	</form>

	<p class="muted">
		{data.areas.length}
		{data.areas.length === 1 ? 'area' : 'areas'}{data.q ? ` matching "${data.q}"` : ''}
	</p>

	{#if data.areas.length}
		<TodayCards
			testId="area-list"
			items={data.areas.map((area) => ({
				...area,
				sub: `${area.plants} ${area.plants === 1 ? 'plant' : 'plants'}`,
				href: resolve('/admin/areas/[id]', { id: area.id })
			}))}
		/>
	{:else}
		<EmptyState
			title={data.q ? 'No area matches' : 'No areas with pumps yet'}
			description={data.q
				? 'Check the spelling, or search by a plant name instead.'
				: 'Pumps are added on the Imports page.'}
		/>
	{/if}
</div>

<style>
	.area-search {
		grid-template-columns: minmax(0, 28rem) auto;
		align-items: end;
	}
	.muted {
		margin: var(--space-3) 0;
		color: var(--ink-muted);
	}
	@media (max-width: 30rem) {
		.area-search {
			grid-template-columns: 1fr;
		}
	}
</style>
