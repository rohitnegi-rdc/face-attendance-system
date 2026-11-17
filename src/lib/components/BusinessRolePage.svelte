<script lang="ts">
	// One admin page for business managers and business heads (load and actions in
	// src/lib/server/businessRoleAdmin.ts): who has which plant. Plants with nobody first, then one
	// card per person with their plants, then the CSV upload.
	import { enhance } from '$app/forms';

	type Plant = { id: string; name: string; areaName: string; pumps: number };
	type Person = {
		id: string;
		name: string;
		email: string;
		plants: Plant[];
		waiting: { name: string; code: string | null }[];
	};
	type Form = {
		formKind?: string;
		message?: string;
		success?: boolean;
		errors?: string[];
	} | null;
	let {
		role,
		data,
		form
	}: {
		role: 'manager' | 'head';
		data: {
			unassigned: Plant[];
			managers: Person[];
			plants: { id: string; name: string; areaName: string }[];
		};
		form: Form;
	} = $props();

	const WORDS = {
		manager: {
			title: 'Business managers',
			one: 'business manager',
			column: 'Business Manager',
			testid: 'bm',
			intro:
				'A business manager approves or rejects the missed days of their plants, by email or in the app, and sees those plants read only. One per plant. A plant without one sends its requests to the admins.',
			noneAlert: 'Missed days at these plants go to the admins.',
			removeNote: "Their plants' missed days go to the admins. Decisions already made stay."
		},
		head: {
			title: 'Business heads',
			one: 'business head',
			column: 'Business Head',
			testid: 'bh',
			intro:
				"A business head sees the attendance, pumps, people and missed days of their plants, read only, and is copied on the 9 am attendance email of those plants' Areas. They decide nothing. One per plant.",
			noneAlert: 'Nobody is copied on the 9 am email for these plants.',
			removeNote: 'They stop seeing their plants and are no longer copied on the 9 am email.'
		}
	} as const;
	const w = $derived(WORDS[role]);

	let newManager = $state(false);
	const keep =
		() =>
		async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) =>
			update({ reset: false });
</script>

<svelte:head><title>{w.title} | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Administration</p>
			<h1>{w.title}</h1>
			<p>{w.intro}</p>
		</div>
	</header>

	{#if form?.formKind === 'row' && form?.message}
		<p class="alert" class:alert--error={!form.success} role="status">{form.message}</p>
	{/if}

	<section class="section" aria-labelledby="none-heading">
		<h2 id="none-heading">
			Plants with no {w.one} <span class="count">{data.unassigned.length}</span>
		</h2>
		{#if data.unassigned.length}
			<p class="alert alert--error">{w.noneAlert}</p>
			<ul class="plain bounded" data-testid="{w.testid}-unassigned">
				{#each data.unassigned as plant (plant.id)}
					<li>
						<strong>{plant.name}</strong>
						<span class="muted"
							>{plant.areaName} · {plant.pumps} {plant.pumps === 1 ? 'pump' : 'pumps'}</span
						>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">Every plant with pumps has a {w.one}.</p>
		{/if}
	</section>

	<section class="surface surface--padded" aria-labelledby="assign-heading">
		<h2 id="assign-heading">Give a plant to a {w.one}</h2>
		{#if form?.formKind === 'assign' && form?.message}
			<p class="alert" class:alert--error={!form.success} role="status">{form.message}</p>
		{/if}
		<form method="POST" action="?/assign" class="grid" use:enhance data-testid="{w.testid}-assign">
			<label class="field"
				><span>Plant</span>
				<select name="plant_id" required>
					<option value="">Choose a plant</option>
					{#each data.plants as plant (plant.id)}
						<option value={plant.id}>{plant.name} ({plant.areaName})</option>
					{/each}
				</select></label
			>
			<label class="field"
				><span>{w.one[0].toUpperCase() + w.one.slice(1)}</span>
				<select
					name="manager_id"
					onchange={(e) => (newManager = (e.currentTarget as HTMLSelectElement).value === '')}
				>
					{#each data.managers as m (m.id)}
						<option value={m.id}>{m.name}</option>
					{/each}
					<option value="" selected={!data.managers.length}>Someone new</option>
				</select></label
			>
			{#if newManager || !data.managers.length}
				<label class="field"><span>Name</span><input name="name" maxlength="200" /></label>
				<label class="field"
					><span>Email</span><input name="email" type="email" placeholder="name@rdc.in" /></label
				>
			{/if}
			<button class="button button--primary" type="submit">Save</button>
		</form>
	</section>

	<section class="section" aria-labelledby="list-heading">
		<h2 id="list-heading">{w.title} <span class="count">{data.managers.length}</span></h2>
		{#if data.managers.length}
			<ul class="cards" data-testid="{w.testid}-list">
				{#each data.managers as m (m.id)}
					<li class="surface surface--padded card" data-testid="{w.testid}-row">
						<div class="head">
							<strong>{m.name}</strong>
							<span class="muted">{m.email}</span>
						</div>
						{#if m.plants.length}
							<ul class="plain">
								{#each m.plants as plant (plant.id)}
									<li class="plant">
										<span
											>{plant.name}
											<span class="muted"
												>{plant.areaName} · {plant.pumps}
												{plant.pumps === 1 ? 'pump' : 'pumps'}</span
											></span
										>
										<form method="POST" action="?/unassign" use:enhance={keep}>
											<input type="hidden" name="plant_id" value={plant.id} />
											<button class="button button--quiet small" type="submit">Take away</button>
										</form>
									</li>
								{/each}
							</ul>
						{/if}
						{#if m.waiting.length}
							<p class="muted small">
								Waiting for plants not in the system yet: {m.waiting
									.map((w) => (w.code ? `${w.name} (${w.code})` : w.name))
									.join(', ')}
							</p>
						{/if}
						{#if !m.plants.length && !m.waiting.length}
							<p class="muted small">No plants.</p>
						{/if}
						<form method="POST" action="?/remove" use:enhance={keep}>
							<input type="hidden" name="id" value={m.id} />
							<button
								class="button button--secondary small"
								type="submit"
								onclick={(e) => {
									if (!confirm(`Remove ${m.name}? ${w.removeNote}`)) e.preventDefault();
								}}>Remove</button
							>
						</form>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">No {w.title.toLowerCase()} yet.</p>
		{/if}
	</section>

	<section class="surface surface--padded" aria-labelledby="upload-heading">
		<h2 id="upload-heading">Upload the list</h2>
		<p class="muted">
			CSV columns: {w.column}, Email, Plant, Plant Code. A plant named in the file moves to the
			{w.one} on its row. A plant not in the system yet waits and joins once it is added.
		</p>
		{#if form?.formKind === 'upload' && form?.message}
			<p class="alert" class:alert--error={!form.success} role="status">{form.message}</p>
			{#if form.errors?.length}
				<ul class="errors">
					{#each form.errors as error (error)}<li>{error}</li>{/each}
				</ul>
			{/if}
		{/if}
		<form method="POST" action="?/upload" enctype="multipart/form-data" class="row" use:enhance>
			<input type="file" name="file" accept=".csv,text/csv" required />
			<button class="button button--primary" type="submit">Upload</button>
		</form>
	</section>
</div>

<style>
	h2 {
		margin: 0 0 var(--space-3);
	}
	.page > section + section {
		margin-top: var(--space-5);
	}
	.count,
	.muted {
		color: var(--ink-muted);
		font-size: var(--text-sm);
		font-weight: 400;
	}
	.small {
		font-size: var(--text-sm);
	}
	.plain {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-2);
	}
	.bounded {
		max-height: 50vh;
		overflow-y: auto;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: var(--space-3);
		align-items: end;
	}
	.grid .button {
		justify-self: start;
	}
	.cards {
		max-height: 70vh;
		overflow-y: auto;
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
		gap: var(--space-3);
	}
	.card {
		display: grid;
		gap: var(--space-3);
		align-content: start;
	}
	.head {
		display: grid;
		overflow-wrap: anywhere;
	}
	.plant {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-2);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: center;
	}
	.row input {
		min-width: 0;
		max-width: 100%;
	}
	.errors {
		color: var(--alert);
		font-size: var(--text-sm);
	}
</style>
