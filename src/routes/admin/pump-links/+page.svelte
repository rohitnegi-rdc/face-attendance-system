<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import Link2 from '@lucide/svelte/icons/link-2';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import SearchField from '$lib/components/SearchField.svelte';
	import { formatDate } from '$lib/date';
	import { applyOnSelect } from '$lib/liveSearch';

	let { data, form } = $props();

	const pagePath = resolve('/admin/pump-links');
	let copied = $state('');
	let copiedTimer: ReturnType<typeof setTimeout>;

	async function copy(pumpId: string, link: string, button: HTMLElement) {
		try {
			await navigator.clipboard.writeText(link);
		} catch {
			// No clipboard outside https: select the link so it can be copied by hand.
			const input = button.closest('li')?.querySelector('input.link-text');
			if (input instanceof HTMLInputElement) {
				input.select();
				document.execCommand('copy');
			}
		}
		copied = pumpId;
		clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => (copied = ''), 2000);
	}
</script>

<svelte:head><title>Pump links | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<h1>Pump links</h1>
			<p>
				Send a pump its link. Opening it signs that pump in directly, with no email or password, and
				the phone stays signed in until it logs out or the link is revoked. Anyone with the link can
				sign in as that pump, so revoke it if it reaches the wrong person.
			</p>
		</div>
	</header>

	<form class="filter-bar links-filter" method="GET" role="search" onchange={applyOnSelect}>
		<SearchField value={data.q} placeholder="Pump, plant, area or vendor" testId="link-search" />
		<label class="field"
			><span>Area</span><select name="area" value={data.areaId} data-testid="link-area">
				<option value="">All areas</option>
				{#each data.areaOptions as area (area.id)}<option value={area.id}>{area.name}</option
					>{/each}
			</select></label
		>
		<div class="filter-actions">
			{#if data.q || data.areaId}<a class="button button--ghost" href={pagePath}>Clear</a>{/if}
		</div>
	</form>

	{#if form?.message}<p class="alert alert--error" role="alert">{form.message}</p>{/if}

	{#each data.areas as area (area.id)}
		<section
			class="area-group"
			aria-labelledby="links-area-{area.id}"
			data-testid="link-area-group"
		>
			<h2 id="links-area-{area.id}">
				{area.name}
				<span>{area.linked} of {area.pumps} with a link</span>
			</h2>
			{#each area.plants as plant (plant.id)}
				<h3>{plant.name}</h3>
				<ul class="pump-rows">
					{#each plant.pumps as pump (pump.id)}
						<li class="pump-row" data-testid="link-row" data-pump={pump.pump_code}>
							<div class="pump-who">
								<strong>{pump.pump_code}</strong>
								<span>{pump.vendor_name}</span>
								{#if pump.status === 'disabled'}<span class="login-off">Login disabled</span>{/if}
							</div>
							{#if pump.link}
								{@const link = pump.link}
								<input
									class="link-text"
									type="text"
									readonly
									value={link}
									aria-label="Link for {pump.pump_code}"
									data-testid="link-url"
									onfocus={(e) => e.currentTarget.select()}
								/>
								<div class="pump-actions">
									<button
										class="button button--primary"
										type="button"
										data-testid="link-copy"
										onclick={(e) => copy(pump.id, link, e.currentTarget)}
									>
										{#if copied === pump.id}<Check size={16} /> Copied{:else}<Copy size={16} /> Copy{/if}
									</button>
									<form
										method="POST"
										action="?/revoke"
										use:enhance={() =>
											async ({ update }) =>
												update({ reset: false })}
									>
										<input type="hidden" name="pump" value={pump.id} />
										<button
											class="button button--secondary"
											type="submit"
											data-testid="link-revoke"
											onclick={(e) => {
												if (
													!confirm(
														`Revoke the link of ${pump.pump_code}? It stops working at once, and a phone signed in with it is signed out.`
													)
												)
													e.preventDefault();
											}}>Revoke</button
										>
									</form>
								</div>
								{#if pump.link_created_at}<small class="made"
										>Made {formatDate(pump.link_created_at)}</small
									>{/if}
							{:else}
								<span class="no-link">No link</span>
								<form
									class="pump-actions"
									method="POST"
									action="?/generate"
									use:enhance={() =>
										async ({ update }) =>
											update({ reset: false })}
								>
									<input type="hidden" name="pump" value={pump.id} />
									<button class="button button--secondary" type="submit" data-testid="link-generate"
										><Link2 size={16} /> Generate link</button
									>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
			{/each}
		</section>
	{:else}
		<EmptyState
			title="No pumps found"
			description={data.q ? `Nothing matches "${data.q}".` : 'No pumps in this area.'}
		/>
	{/each}
</div>

<style>
	.links-filter {
		grid-template-columns: minmax(0, 22rem) minmax(0, 14rem) auto;
		align-items: end;
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
	}
	.pump-row {
		display: grid;
		grid-template-columns: minmax(9rem, 13rem) minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-1) var(--space-3);
		padding: var(--space-2) var(--space-3);
	}
	.pump-row + .pump-row {
		border-top: 1px solid var(--brand-mist);
	}
	.pump-who {
		display: grid;
		min-width: 0;
	}
	.pump-who span {
		overflow-wrap: anywhere;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.pump-who .login-off {
		color: #b3261e;
		font-weight: 600;
	}
	.link-text {
		width: 100%;
		min-width: 0;
		font-size: var(--text-sm);
		text-overflow: ellipsis;
	}
	.no-link,
	.made {
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.made {
		grid-column: 2 / -1;
	}
	.pump-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-2);
	}
	@media (max-width: 40rem) {
		.links-filter,
		.pump-row {
			grid-template-columns: 1fr;
		}
		.pump-actions {
			justify-content: flex-start;
		}
		.made {
			grid-column: auto;
		}
	}
</style>
