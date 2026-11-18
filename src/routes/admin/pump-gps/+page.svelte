<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import SearchField from '$lib/components/SearchField.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { GPS_STATE_LABEL, gpsAgo, mapsUrl, type GpsState } from '$lib/gpsAge';
	import { applyFilters, applyOnSelect } from '$lib/liveSearch';

	let { data } = $props();

	const pagePath = resolve('/admin/pump-gps');
	const REFRESH_MS = 60_000;
	const TONE: Record<GpsState, 'success' | 'critical' | 'attention'> = {
		fresh: 'success',
		old: 'attention',
		none: 'critical'
	};
	const CHIPS: { state: GpsState | ''; label: string }[] = [
		{ state: 'none', label: 'No GPS' },
		{ state: 'old', label: 'Too old' },
		{ state: 'fresh', label: 'Fresh' },
		{ state: '', label: 'All' }
	];
	const total = $derived(data.counts.none + data.counts.old + data.counts.fresh);

	let filterForm = $state<HTMLFormElement>();
	// Follows the page's filter, and a chip tap sets it before the form is read.
	let gpsFilter = $derived<string>(data.state);
	function showState(state: GpsState | '') {
		gpsFilter = state;
		// Let the hidden input take the new value before the form is read.
		queueMicrotask(() => filterForm && applyFilters(filterForm));
	}

	// Fresh data every minute while the page is open and visible, and on coming back to the tab.
	let refreshing = $state(false);
	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}
	// True once the refresh timer runs in the browser (tests wait for it before moving the clock).
	let live = $state(false);
	$effect(() => {
		live = true;
		const visible = () => document.visibilityState === 'visible';
		const timer = setInterval(() => visible() && refresh(), REFRESH_MS);
		const onVisible = () => visible() && refresh();
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});
</script>

<svelte:head><title>Pump GPS | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<h1>Pump GPS</h1>
			<p>
				Each pump's latest position from the GPS feed, copied every 5 minutes. A shift start passes
				the location check only when the pump's position is under {data.maxAgeMinutes} minutes old; otherwise
				it waits for the plant manager's approval. The tracker name is the pump code unless a GPS provider
				id is set on the pump's page.
			</p>
		</div>
	</header>

	<div class="live" data-testid="gps-live" data-ready={live}>
		<span role="status" aria-live="polite"
			>Updated <strong data-testid="gps-updated">{data.updatedAt}</strong>. Refreshes every minute.</span
		>
		<button
			class="button button--secondary"
			type="button"
			onclick={refresh}
			disabled={refreshing}
			data-testid="gps-refresh"
			><span class="spin" class:spin--on={refreshing}><RefreshCw size={16} /></span>
			{refreshing ? 'Refreshing' : 'Refresh now'}</button
		>
	</div>

	<form
		class="filter-bar gps-filter"
		method="GET"
		role="search"
		onchange={applyOnSelect}
		bind:this={filterForm}
	>
		<SearchField
			value={data.q}
			placeholder="Pump, tracker, plant, area or vendor"
			testId="gps-search"
		/>
		<label class="field"
			><span>Area</span><select name="area" value={data.areaId} data-testid="gps-area">
				<option value="">All areas</option>
				{#each data.areaOptions as area (area.id)}<option value={area.id}>{area.name}</option
					>{/each}
			</select></label
		>
		<input type="hidden" name="gps" value={gpsFilter} />
		<div class="filter-actions">
			{#if data.q || data.areaId || data.state}<a class="button button--ghost" href={pagePath}
					>Clear</a
				>{/if}
		</div>
	</form>

	<div class="chips" role="group" aria-label="Show pumps by GPS" data-testid="gps-chips">
		{#each CHIPS as chip (chip.state)}
			<button
				type="button"
				class="chip chip--{chip.state || 'all'}"
				aria-pressed={data.state === chip.state}
				data-testid="gps-chip-{chip.state || 'all'}"
				onclick={() => showState(chip.state)}
			>
				{chip.label}
				<strong>{chip.state ? data.counts[chip.state] : total}</strong>
			</button>
		{/each}
	</div>

	{#each data.areas as area (area.id)}
		<section class="area-group" aria-labelledby="gps-area-{area.id}" data-testid="gps-area-group">
			<h2 id="gps-area-{area.id}">
				{area.name}
				<span
					>{area.counts.fresh} fresh, {area.counts.old} too old, {area.counts.none} no GPS{area.locationCheck
						? ''
						: '. Location check off in this area'}</span
				>
			</h2>
			{#each area.plants as plant (plant.id)}
				<h3>{plant.name}</h3>
				<ul class="pump-rows">
					{#each plant.pumps as pump (pump.id)}
						<li
							class="pump-row pump-row--{pump.state}"
							data-testid="gps-row"
							data-pump={pump.pump_code}
							data-state={pump.state}
						>
							<div class="who">
								<a href={resolve(`/admin/pumps/${pump.id}`)}><strong>{pump.pump_code}</strong></a>
								<span>{pump.vendor_name}</span>
								{#if pump.has_provider_id}
									<span class="tracker" data-testid="gps-tracker">GPS from {pump.gps_name}</span>
								{/if}
							</div>
							<div class="when" data-testid="gps-when">
								<StatusBadge tone={TONE[pump.state]}>{GPS_STATE_LABEL[pump.state]}</StatusBadge>
								{#if pump.at && pump.age_minutes !== null}
									<span>{pump.at}</span>
									<span class="muted"
										>{gpsAgo(pump.age_minutes)}{pump.source === 'admin'
											? ', entered by admin'
											: ''}</span
									>
								{:else}
									<span class="muted">Nothing received from {pump.gps_name}</span>
								{/if}
							</div>
							<div class="count" data-testid="gps-count">
								<strong>{pump.feed_24h}</strong>
								<span class="muted">positions in 24 h</span>
							</div>
							<div class="map">
								{#if pump.lat !== null && pump.lng !== null}
									<!-- eslint-disable svelte/no-navigation-without-resolve -- Google Maps, outside the app -->
									<a
										class="button button--secondary"
										href={mapsUrl(pump.lat, pump.lng)}
										target="_blank"
										rel="noopener noreferrer"
										data-testid="gps-map"
										aria-label="Open {pump.pump_code} in Google Maps"
										><ExternalLink size={16} /> Google Maps</a
									>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
									<span class="coords">{pump.lat}, {pump.lng}</span>
								{:else}
									<span class="muted">No position to show</span>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/each}
		</section>
	{:else}
		<EmptyState
			title="No pumps found"
			description={data.q || data.state
				? 'No pump matches these filters.'
				: 'No pumps in this area.'}
		/>
	{/each}
</div>

<style>
	.live {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2) var(--space-3);
		margin-bottom: var(--space-3);
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.spin {
		display: inline-flex;
	}
	.spin--on {
		animation: spin 0.9s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spin--on {
			animation: none;
		}
	}
	.gps-filter {
		grid-template-columns: minmax(0, 22rem) minmax(0, 14rem) auto;
		align-items: end;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-3);
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 2.5rem;
		padding: 0 var(--space-3);
		border: 1px solid var(--brand-mist);
		border-radius: 999px;
		background: var(--surface-raised);
		color: var(--ink-default);
		font: inherit;
		font-size: var(--text-sm);
		cursor: pointer;
	}
	.chip strong {
		font-variant-numeric: tabular-nums;
	}
	.chip--none strong {
		color: var(--alert);
	}
	.chip[aria-pressed='true'] {
		border-color: var(--brand-teal);
		background: var(--primary-tint);
		font-weight: 600;
	}
	.area-group {
		margin-top: var(--space-5);
	}
	.area-group h2 {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-2);
		margin: 0;
		font-size: var(--text-lg);
	}
	.area-group h2 span {
		color: var(--ink-muted);
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.area-group h3 {
		margin: var(--space-3) 0 var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.pump-rows {
		margin: 0;
		padding: 0;
		list-style: none;
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
		overflow: hidden;
	}
	.pump-row {
		display: grid;
		grid-template-columns: minmax(9rem, 12rem) minmax(0, 1fr) 7rem minmax(10rem, 12rem);
		align-items: center;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-3);
		border-left: 4px solid transparent;
	}
	.pump-row + .pump-row {
		border-top: 1px solid var(--brand-mist);
	}
	.pump-row--none {
		border-left-color: var(--alert);
		background: var(--alert-tint);
	}
	.pump-row--old {
		border-left-color: var(--alert);
	}
	.who,
	.count,
	.map {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.who span,
	.muted,
	.coords {
		color: var(--ink-muted);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
	.tracker {
		font-weight: 600;
	}
	.when {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-2);
		min-width: 0;
	}
	.count strong {
		font-size: var(--text-lg);
		font-variant-numeric: tabular-nums;
	}
	.map .button {
		justify-content: center;
	}
	.coords {
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
	}
	@media (max-width: 52rem) {
		.gps-filter,
		.pump-row {
			grid-template-columns: 1fr;
		}
		.count {
			display: flex;
			align-items: baseline;
			gap: var(--space-2);
		}
		.count strong {
			font-size: var(--text-base);
		}
		.map .button {
			justify-self: start;
		}
	}
</style>
