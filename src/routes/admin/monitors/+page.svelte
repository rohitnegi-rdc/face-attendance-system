<script lang="ts">
	// Monitors (load and actions in +page.server.ts): who watches which Areas. Add form first, then
	// one card per monitor with its Areas as ticks, so the Areas of two monitors compare side by side.
	import { enhance } from '$app/forms';
	import UserPlus from '@lucide/svelte/icons/user-plus';

	let { data, form } = $props();

	const areaName = (id: string) => data.areas.find((a: any) => a.id === id)?.name ?? 'Area';
</script>

<svelte:head><title>Monitors | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Administration</p>
			<h1>Monitors</h1>
			<p>
				A monitor checks every pump of their areas each day and fixes attendance like a plant
				manager: ticks, wrong worker, a missed worker, same people. They get an email at 8 pm with
				the pumps that need a look.
			</p>
		</div>
	</header>

	<section class="surface surface--padded" aria-labelledby="add-heading">
		<h2 id="add-heading">Add a monitor</h2>
		{#if form?.formKind === 'add' && form?.message}<p
				class="alert"
				class:alert--error={!form.success}
				role="status"
			>
				{form.message}
			</p>{/if}
		{#if form?.formKind === 'add' && form?.credentials}
			<div class="credential-notice" role="status" data-testid="monitor-credentials">
				<strong>Give these first sign-in details to the monitor now. They are shown once.</strong>
				<code>{form.credentials.email}</code>
				<code>{form.credentials.password}</code>
			</div>
		{/if}
		<form method="POST" action="?/add" class="add-form" use:enhance data-testid="monitor-add">
			<label class="field"
				><span>Name</span><input name="name" maxlength="200" autocomplete="off" /></label
			>
			<label class="field"
				><span>Email</span><input
					name="email"
					type="email"
					required
					autocomplete="off"
					placeholder="name@rdc.in"
				/></label
			>
			<fieldset class="areas">
				<legend>Areas to monitor</legend>
				{#each data.areas as area (area.id)}
					<label class="area"
						><input type="checkbox" name="area_id" value={area.id} />
						{area.name} <small>{area.pumps} pumps</small></label
					>
				{/each}
			</fieldset>
			<button class="button button--primary" type="submit"
				><UserPlus size={17} /> Add monitor</button
			>
		</form>
	</section>

	<section class="section" aria-labelledby="list-heading">
		<h2 id="list-heading">
			Monitors <span class="count">{data.monitors.length}</span>
		</h2>
		{#if form?.formKind === 'list' && form?.message}<p class="alert" role="status">
				{form.message}
			</p>{/if}
		{#if data.monitors.length}
			<ul class="monitors" data-testid="monitor-list">
				{#each data.monitors as monitor (monitor.id)}
					<li class="monitor surface surface--padded" data-testid="monitor-row">
						<div class="monitor__head">
							<strong>{monitor.name}</strong>
							<span class="muted">{monitor.email}</span>
							<span class="muted"
								>{monitor.area_ids.map(areaName).join(', ')} · {monitor.pumps} pumps</span
							>
						</div>
						{#if form?.formKind === 'row' && form?.id === monitor.id}
							<p class="alert" class:alert--error={!form.success} role="status">{form.message}</p>
							{#if form?.credentials}
								<div class="credential-notice" role="status">
									<strong
										>Give these to the monitor now. The password cannot be viewed again.</strong
									>
									<code>{form.credentials.email}</code>
									<code>{form.credentials.password}</code>
								</div>
							{/if}
						{/if}
						<form
							method="POST"
							action="?/areas"
							use:enhance={() =>
								async ({ update }) =>
									update({ reset: false })}
						>
							<input type="hidden" name="id" value={monitor.id} />
							<fieldset class="areas">
								<legend>Areas</legend>
								{#each data.areas as area (area.id)}
									<label class="area"
										><input
											type="checkbox"
											name="area_id"
											value={area.id}
											checked={monitor.area_ids.includes(area.id)}
										/>
										{area.name}</label
									>
								{/each}
							</fieldset>
							<div class="monitor__actions">
								<button class="button button--primary" type="submit">Save areas</button>
								<button
									class="button button--secondary"
									type="submit"
									formaction="?/resetPassword"
									onclick={(e) => {
										if (
											!confirm(
												`Reset the password of ${monitor.name}? The current password stops working at once.`
											)
										)
											e.preventDefault();
									}}>Reset password</button
								>
								<button
									class="button button--ghost"
									type="submit"
									formaction="?/remove"
									onclick={(e) => {
										if (
											!confirm(
												`${monitor.name} stops monitoring and can no longer sign in, unless they also manage plants. Their fixes stay in the history.`
											)
										)
											e.preventDefault();
									}}>Remove</button
								>
							</div>
						</form>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">No monitors yet. Add one above.</p>
		{/if}
	</section>
</div>

<style>
	.eyebrow {
		margin: 0 0 var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
	}
	h2 {
		margin: 0 0 var(--space-3);
	}
	.count,
	.muted,
	.area small {
		color: var(--ink-muted);
		font-size: var(--text-sm);
		font-weight: 400;
	}
	.add-form {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
		margin-top: var(--space-3);
	}
	.add-form .areas,
	.add-form .button {
		grid-column: 1 / -1;
	}
	.add-form .button {
		justify-self: start;
	}
	.field {
		display: grid;
		gap: var(--space-1);
	}
	.field > span,
	.areas legend {
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.areas {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		border: 0;
	}
	.areas legend {
		margin-bottom: var(--space-2);
	}
	.area {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 2.75rem;
		padding: 0 var(--space-3);
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
		cursor: pointer;
	}
	.area {
		white-space: nowrap;
	}
	.area input {
		flex: none;
		width: 1.125rem;
		height: 1.125rem;
		min-height: 0;
		margin: 0;
	}
	.area:has(input:checked) {
		border-color: var(--brand-teal);
		box-shadow: 0 0 0 1px var(--brand-teal);
	}
	.monitors {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 24rem), 1fr));
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.monitor {
		display: grid;
		gap: var(--space-3);
		align-content: start;
	}
	.monitor__head {
		display: grid;
		gap: var(--space-1);
	}
	.monitor__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-3);
	}
	.alert {
		margin: var(--space-3) 0 0;
	}
	.credential-notice {
		display: grid;
		gap: var(--space-2);
		margin-top: var(--space-3);
		padding: var(--space-3);
		background: var(--surface-muted);
		border-left: 3px solid var(--brand-teal);
	}
	.credential-notice code {
		user-select: all;
		overflow-wrap: anywhere;
	}
	@media (max-width: 38rem) {
		.add-form {
			grid-template-columns: 1fr;
		}
	}
</style>
