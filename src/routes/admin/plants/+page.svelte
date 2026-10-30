<script lang="ts">
	import { resolve } from '$app/paths';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import TodayCards from '$lib/components/TodayCards.svelte';
	import { formatDate } from '$lib/date';

	let { data } = $props();

	const plantsPath = resolve('/admin/plants');
	// One heading per area, its plants as cards below.
	const groups = $derived.by(() => {
		const out: { id: string; name: string; plants: typeof data.plants }[] = [];
		for (const plant of data.plants) {
			let group = out.at(-1);
			if (!group || group.id !== plant.areaId)
				out.push((group = { id: plant.areaId!, name: plant.areaName!, plants: [] }));
			group.plants.push(plant);
		}
		return out;
	});
</script>

<svelte:head><title>Plants | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<h1>Plants</h1>
			<p>Today, {formatDate(data.today)}. Open a plant for its pumps and calendar.</p>
		</div>
	</header>

	<form class="filter-bar plant-search" method="GET" role="search">
		<label class="field"
			><span>Search</span><input
				name="q"
				type="search"
				value={data.q}
				placeholder="Plant or area name"
				autocomplete="off"
				data-testid="plant-search"
			/></label
		>
		<label class="field"
			><span>Area</span><select name="area" value={data.areaId} data-testid="plant-area">
				<option value="">All areas</option>
				{#each data.areas as area (area.id)}<option value={area.id}>{area.name}</option>{/each}
			</select></label
		>
		<div class="filter-actions">
			<button class="button button--primary" type="submit">Show</button>
			{#if data.q || data.areaId}<a class="button button--ghost" href={plantsPath}>Clear</a>{/if}
		</div>
	</form>

	<p class="muted">
		{data.plants.length}
		{data.plants.length === 1 ? 'plant' : 'plants'}{data.q ? ` matching "${data.q}"` : ''}
	</p>

	{#each groups as group (group.id)}
		<section class="area-group" aria-labelledby="area-{group.id}">
			<h2 id="area-{group.id}">
				<a href={resolve('/admin/areas/[id]', { id: group.id })}>{group.name}</a>
				<span>{group.plants.length} {group.plants.length === 1 ? 'plant' : 'plants'}</span>
			</h2>
			<TodayCards
				testId="plant-list"
				items={group.plants.map((plant) => ({
					...plant,
					href: resolve('/admin/plants/[id]', { id: plant.id })
				}))}
			/>
		</section>
	{:else}
		<EmptyState
			title={data.q || data.areaId ? 'No plant matches' : 'No plants with pumps yet'}
			description={data.q || data.areaId
				? 'Check the spelling, or pick All areas.'
				: 'Pumps are added on the Imports page.'}
		/>
	{/each}
</div>

<style>
	.plant-search {
		grid-template-columns: minmax(0, 22rem) minmax(0, 14rem) auto;
		align-items: end;
	}
	.muted {
		margin: var(--space-3) 0;
		color: var(--ink-muted);
	}
	.area-group + .area-group {
		margin-top: var(--space-5);
	}
	.area-group h2 {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		margin: 0 0 var(--space-2);
		font-size: var(--text-lg);
	}
	.area-group h2 a {
		color: var(--ink-strong);
	}
	.area-group h2 span {
		color: var(--ink-muted);
		font-size: var(--text-sm);
		font-weight: 600;
	}
	@media (max-width: 40rem) {
		.plant-search {
			grid-template-columns: 1fr;
		}
	}
</style>
