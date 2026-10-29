<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Search from '@lucide/svelte/icons/search';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import FacePeek from '$lib/components/FacePeek.svelte';
	import { formatDate } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';
	// The People list of the vendor and the plant manager: one row per active worker, with an
	// inline name correction (the page's ?/rename action, personNames.ts).
	let { data, form, eyebrow, intro }: { data: any; form: any; eyebrow: string; intro: string } =
		$props();

	// The worker whose name is being corrected (one at a time).
	let editing = $state('');
</script>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">{eyebrow}</p>
			<h1>People</h1>
			<p>{intro}</p>
		</div>
	</header>
	<form class="filter-bar compact-filter" method="GET">
		<label class="field"
			><span>Pump</span><select name="pump"
				><option value="">All pumps</option>{#each data.pumps as pump}<option
						value={pump.id}
						selected={pump.id === data.pump}>{pump.pump_code}</option
					>{/each}</select
			></label
		>
		<div class="filter-actions">
			<button class="button button--primary" type="submit"><Search size={17} /> Apply</button>
		</div>
	</form>
	<section class="section">
		{#if data.persons.length}
			<div class="table-wrap">
				<table class="data-table" data-testid="people-table">
					<thead
						><tr
							><th>Person</th><th>Pump</th><th>First seen</th><th>Last seen</th><th>Full shift</th
							><th>Start only</th><th>End only</th></tr
						></thead
					><tbody
						>{#each data.persons as person (person.id)}
							{@const label = personDisplayLabel(
								person.pump_code,
								person.display_seq,
								person.is_operator,
								person.name
							)}
							<tr
								><td>
									{#if editing === person.id}
										<form
											class="rename-form"
											method="POST"
											action="?/rename"
											use:enhance={() =>
												async ({ result, update }) => {
													await update({ reset: false });
													if (result.type === 'success') editing = '';
												}}
										>
											<span class="person-cell rename-form__who">
												<FacePeek
													url={resolve('/api/persons/[id]/face', { id: person.id })}
													{label}
												/>
												<strong>{label}</strong>
											</span>
											<input type="hidden" name="person_id" value={person.id} />
											<!-- svelte-ignore a11y_autofocus -->
											<input
												name="name"
												value={person.name ?? ''}
												maxlength="60"
												required
												autofocus
												placeholder="Full name"
												aria-label="Name of {label}"
												data-testid="rename-input"
											/>
											<button class="button button--primary" type="submit">Save</button>
											<button
												class="button button--secondary"
												type="button"
												onclick={() => (editing = '')}>Cancel</button
											>
											{#if form?.error && form.personId === person.id}<p
													class="form-error"
													role="alert"
												>
													{form.error}
												</p>{/if}
										</form>
									{:else}
										<span class="person-cell">
											<FacePeek
												url={resolve('/api/persons/[id]/face', { id: person.id })}
												{label}
											/>
											<strong class:unnamed={!person.name}>{label}</strong>
											<button
												class="icon-button"
												type="button"
												title="Edit name"
												aria-label="Edit name of {label}"
												onclick={() => (editing = person.id)}><Pencil size={15} /></button
											>
										</span>
									{/if}
								</td><td>{person.pump_code}</td><td>{formatDate(person.first_seen_at)}</td><td
									>{formatDate(person.last_seen_at)}</td
								><td>{person.days_present}</td><td>{person.days_morning_only}</td><td
									>{person.days_evening_only}</td
								></tr
							>{/each}</tbody
					>
				</table>
			</div>
		{:else}<EmptyState
				title="No people found"
				description="Try another pump, or wait for completed attendance processing."
			/>{/if}
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
	.compact-filter {
		grid-template-columns: minmax(12rem, 20rem) auto;
		justify-content: start;
	}
	.person-cell {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		white-space: nowrap;
	}
	.unnamed {
		color: var(--ink-muted);
	}
	.rename-form {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		min-width: 16rem;
	}
	.rename-form__who {
		flex-basis: 100%;
	}
	.rename-form input[name='name'] {
		flex: 1;
		min-width: 10rem;
	}
	.form-error {
		flex-basis: 100%;
		margin: 0;
		color: var(--alert);
		font-size: var(--text-sm);
	}
	@media (max-width: 36rem) {
		.compact-filter {
			grid-template-columns: 1fr;
		}
	}
</style>
