<script lang="ts">
	import { resolve } from '$app/paths';
	import Plus from '@lucide/svelte/icons/plus';

	let { data, form } = $props();
</script>

<svelte:head><title>Vendors | Face Attendance</title></svelte:head>

<div class="page vendors-page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Administration</p>
			<h1>Vendors</h1>
			<p>Every vendor login, its scope, and the pumps it can see.</p>
		</div>
	</header>
	{#if form?.formKind === 'reset'}
		<p class:alert--error={!form.success} class="alert" role="status">{form.message}</p>
	{/if}
	{#if form?.credentials}
		<div class="credential-notice" role="status">
			<strong
				>{form.formKind === 'reset'
					? 'Password reset to the default. Give these to the user.'
					: 'Copy these one-time credentials now. The password cannot be viewed again.'}</strong
			>
			<code>{form.credentials.email}</code><code>{form.credentials.password}</code>
		</div>
	{/if}

	<div class="creation-grid">
		<section class="surface surface--padded">
			<h2>New vendor</h2>
			<p class="supporting-text">
				Leave area blank for a single national login. Only RDC-style vendors that operate across
				areas need one login per area.
			</p>
			{#if form?.formKind === 'vendor'}
				<p class:alert--error={!form.success} class="alert" role="status">{form.message}</p>
			{/if}
			<form method="POST" action="?/createVendor" class="stacked-form">
				<label
					><span>Vendor name</span>
					<input name="name" required maxlength="200" placeholder="e.g. R V N Enterprises" /></label
				>
				<label
					><span>Area (optional — for area-split logins)</span>
					<select name="area_id">
						<option value="">No area — national login</option>
						{#each data.areas as area}
							<option value={area.id}>{area.name}</option>
						{/each}
					</select></label
				>
				<button class="button button--primary" type="submit"
					><Plus size={16} /> Create vendor</button
				>
			</form>
		</section>

		<section class="surface surface--padded">
			<h2>New pump</h2>
			<p class="supporting-text">Login email is generated from the pump code automatically.</p>
			{#if form?.formKind === 'pump'}
				<p class:alert--error={!form.success} class="alert" role="status">{form.message}</p>
			{/if}
			<form method="POST" action="?/createPump" class="stacked-form">
				<label
					><span>Pump code</span>
					<input name="pump_code" required maxlength="100" placeholder="e.g. BGLPRVN5" /></label
				>
				<label
					><span>Vendor</span>
					<select name="vendor_id" required>
						<option value="">Select vendor</option>
						{#each data.vendors as vendor}
							<option value={vendor.id}
								>{vendor.name}{vendor.area_name ? ` (${vendor.area_name})` : ''}</option
							>
						{/each}
					</select></label
				>
				<label
					><span>Plant</span>
					<select name="plant_id" required>
						<option value="">Select plant</option>
						{#each data.plants as plant}
							<option value={plant.id}>{plant.area_name} / {plant.name}</option>
						{/each}
					</select></label
				>
				<button class="button button--primary" type="submit"><Plus size={16} /> Create pump</button>
			</form>
		</section>
	</div>

	<section class="section">
		<div class="section-header">
			<div>
				<h2>All vendors</h2>
				<p class="supporting-text" data-testid="vendor-total">
					{#if data.q}
						{data.matches.length} of {data.vendors.length} logins matching "{data.q}".
					{:else}
						{data.vendors.length} login{data.vendors.length === 1 ? '' : 's'}.
					{/if}
				</p>
			</div>
		</div>
		<form class="filter-bar vendor-search" method="GET" role="search">
			<label class="field"
				><span>Search</span><input
					name="q"
					type="search"
					value={data.q}
					placeholder="e.g. RDC, Mumbai, Kapcom"
					autocomplete="off"
					data-testid="vendor-search"
				/></label
			>
			<div class="filter-actions">
				<button class="button button--primary" type="submit">Search</button>
				{#if data.q}<a class="button button--ghost" href={resolve('/admin/vendors')}>Clear</a>{/if}
			</div>
		</form>
		<div class="table-wrap bounded-table-frame">
			<table class="data-table">
				<thead>
					<tr
						><th>Vendor</th><th>Scope</th><th>Login email</th><th>Pumps</th><th>Access</th><th
						></th></tr
					>
				</thead>
				<tbody>
					{#each data.matches as vendor}
						<tr>
							<td>{vendor.name}</td>
							<td>{vendor.area_name ?? 'National'}</td>
							<td>{vendor.email}</td>
							<td>{vendor.pump_count}</td>
							<td
								><form
									method="POST"
									action={data.q
										? `?q=${encodeURIComponent(data.q)}&/resetVendorPassword`
										: '?/resetVendorPassword'}
								>
									<input type="hidden" name="id" value={vendor.id} /><button
										class="button button--secondary"
										type="submit"
										onclick={(e) => {
											if (
												!confirm(
													`Reset the password of ${vendor.name}? The current password stops working at once.`
												)
											)
												e.preventDefault();
										}}>Reset password</button
									>
								</form></td
							>
							<td
								><a class="button button--secondary" href={resolve(`/admin/vendors/${vendor.id}`)}
									>View</a
								></td
							>
						</tr>
					{/each}
					{#if !data.matches.length}
						<tr
							><td colspan="6"
								>{data.q
									? 'No vendor matches. Check the spelling, or search by area or login instead.'
									: 'No vendors yet. Create one above or import a CSV.'}</td
							></tr
						>
					{/if}
				</tbody>
			</table>
		</div>
	</section>
</div>

<style>
	.vendors-page {
		--content-max: 82rem;
	}
	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-4);
		flex-wrap: wrap;
	}
	.eyebrow {
		margin: 0 0 var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
	}
	.creation-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-4);
	}
	.creation-grid h2 {
		margin: 0 0 var(--space-1);
	}
	.supporting-text {
		margin: 0 0 var(--space-3);
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.stacked-form {
		display: grid;
		gap: var(--space-3);
	}
	.stacked-form label {
		display: grid;
		gap: var(--space-1);
	}
	.stacked-form label > span {
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.alert {
		margin-bottom: var(--space-3);
	}
	.credential-notice {
		display: grid;
		gap: var(--space-2);
		margin-bottom: var(--space-4);
		padding: var(--space-3);
		background: var(--surface-muted);
		border-left: 3px solid var(--brand-teal);
	}
	.credential-notice code {
		user-select: all;
		overflow-wrap: anywhere;
	}
	.vendor-search {
		grid-template-columns: minmax(0, 28rem) auto;
		align-items: end;
		margin-bottom: var(--space-3);
	}
	.bounded-table-frame {
		max-height: 32rem;
		overflow: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
		scrollbar-width: thin;
		scrollbar-color: var(--brand-mist) var(--surface-muted);
	}
	@media (max-width: 30rem) {
		.vendor-search {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 60rem) {
		.creation-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
