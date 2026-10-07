<script lang="ts">
	import Building2 from '@lucide/svelte/icons/building-2';
	import Plus from '@lucide/svelte/icons/plus';
	let { data, form } = $props();
</script>

<svelte:head><title>Plant managers | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Administration</p>
			<h1>Plant managers</h1>
			<p>Assign one manager to each plant. A manager account can cover multiple plants.</p>
		</div>
	</header>

	<section class="surface surface--padded assignment-panel" aria-labelledby="assignment-heading">
		<h2 id="assignment-heading">Assign or transfer a plant</h2>
			<p class="supporting-text">Choose an existing manager by email. Enter a name only when creating a new account or correcting a name.</p>
		{#if form?.message}<p class:alert--error={!form.success} class="alert" role="status">{form.message}</p>{/if}
		{#if form?.credentials}
			<div class="credential-notice" role="status">
				<strong>Show these first-login details to the manager now.</strong>
				<code>{form.credentials.email}</code>
				<code>{form.credentials.password}</code>
			</div>
		{/if}
		<form method="POST" action="?/assign" class="assign-form">
			<label class="field"><span>Plant</span>
				<select name="plant_id" required>
					<option value="">Select plant</option>
					{#each data.plants as plant}<option value={plant.id}>{plant.area_name} / {plant.plant_name}</option>{/each}
				</select>
			</label>
			<label class="field"><span>Manager email</span>
				<input name="manager_email" type="email" list="manager-emails" required autocomplete="off" placeholder="Search or enter email" />
				<datalist id="manager-emails">
					{#each data.managers as manager}<option value={manager.email}>{manager.name}</option>{/each}
					{#each data.plants as plant}{#if plant.contact_email}<option value={plant.contact_email}>{plant.contact_name}</option>{/if}{/each}
				</datalist>
			</label>
			<label class="field"><span>Manager name</span>
				<input name="manager_name" maxlength="200" placeholder="Required for a new account" />
			</label>
			<button class="button button--primary" type="submit"><Plus size={17} /> Save assignment</button>
		</form>
	</section>

	<section class="section">
		<div class="section-header"><div><h2>Plant assignments</h2><p class="supporting-text">{data.plants.length} plants · {data.managers.length} manager accounts</p></div></div>
		<div class="table-wrap">
			<table class="data-table">
				<thead><tr><th>Plant</th><th>Area</th><th>Manager</th><th>Account email</th><th>Pumps</th></tr></thead>
				<tbody>
					{#each data.plants as plant}
						<tr>
							<td><strong>{plant.plant_name}</strong></td>
							<td>{plant.area_name}</td>
							<td>{#if plant.manager_id}{plant.manager_name}{:else}<strong>Unassigned</strong>{#if plant.contact_name}<small>Reference: {plant.contact_name}</small>{/if}{/if}</td>
							<td>{plant.manager_email ?? '—'}</td>
							<td>{plant.pump_count}</td>
						</tr>
					{/each}
					{#if !data.plants.length}<tr><td colspan="5">No plants are available.</td></tr>{/if}
				</tbody>
			</table>
		</div>
	</section>
</div>

<style>
	.eyebrow { margin: 0 0 var(--space-1); color: var(--ink-muted); font-size: var(--text-xs); font-weight: 700; text-transform: uppercase; }
	.assignment-panel h2 { margin: 0 0 var(--space-1); }
	.supporting-text { margin: 0; color: var(--ink-muted); font-size: var(--text-sm); }
	.assign-form { display: grid; grid-template-columns: minmax(12rem, 1fr) minmax(13rem, 1.2fr) minmax(12rem, 1fr) auto; align-items: end; gap: var(--space-3); margin-top: var(--space-4); }
	.assign-form .field { display: grid; gap: var(--space-1); }
	.assign-form .field > span { font-size: var(--text-sm); font-weight: 600; }
	.alert { margin-top: var(--space-3); }
	.credential-notice { display: grid; gap: var(--space-2); margin-top: var(--space-3); padding: var(--space-3); background: var(--surface-muted); border-left: 3px solid var(--brand-teal); }
	.credential-notice code { user-select: all; }
	.data-table small { display: block; margin-top: var(--space-1); color: var(--ink-muted); }
	@media (max-width: 64rem) { .assign-form { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
	@media (max-width: 38rem) { .assign-form { grid-template-columns: 1fr; } }
</style>
