<script lang="ts">
	// The Gangs list, the same for the admin and the plant manager (src/lib/server/gangs.ts):
	// "Same person?" questions first, then every gang by Area and the plant it last worked at.
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import SearchField from '$lib/components/SearchField.svelte';
	import { formatDate, formatDateTime } from '$lib/date';
	import type { listGangs } from '$lib/server/gangs';

	type Data = Awaited<ReturnType<typeof listGangs>>;
	let {
		data,
		form,
		base
	}: {
		data: Data;
		form: { formKind?: string; success?: boolean; message?: string } | null;
		base: 'admin' | 'plant-manager';
	} = $props();

	const gangHref = (id: string) =>
		base === 'admin' ? resolve(`/admin/gangs/${id}`) : resolve(`/plant-manager/gangs/${id}`);
	const faceSrc = (id: string) => resolve(`/api/attendance/face/${id}`);
	const pagePath = $derived(
		base === 'admin' ? resolve('/admin/gangs') : resolve('/plant-manager/gangs')
	);

	// Area, then plant, keeping the server's order (newest first inside a plant).
	const groups = $derived.by(() => {
		const areas: { name: string; plants: { name: string; gangs: Data['gangs'] }[] }[] = [];
		for (const gang of data.gangs) {
			let area = areas.at(-1);
			if (!area || area.name !== gang.area_name) {
				area = { name: gang.area_name, plants: [] };
				areas.push(area);
			}
			const plantName = gang.last_plant_name ?? 'Not seen yet';
			let plant = area.plants.at(-1);
			if (!plant || plant.name !== plantName) {
				plant = { name: plantName, gangs: [] };
				area.plants.push(plant);
			}
			plant.gangs.push(gang);
		}
		return areas;
	});
</script>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<h1>Gangs</h1>
			<p>
				A gang is recognised from faces, never from names: its first shift photo starts it, and a
				shift counts for the gang most of its faces belong to, at whichever pump of the Area it
				works. Headcount counts each worker once a day.
			</p>
		</div>
	</header>

	{#if form?.message}
		<p class="alert" class:alert--error={!form.success} role="status">{form.message}</p>
	{/if}

	{#if data.linkQuestions.length}
		<section class="surface surface--padded questions" aria-labelledby="same-person-heading">
			<h2 id="same-person-heading">Same person? ({data.linkQuestions.length})</h2>
			<p class="supporting-text">
				A new worker looked like a worker at another pump of the Area, but not clearly enough to be
				sure. Look at both faces.
			</p>
			<ul class="question-list">
				{#each data.linkQuestions as question (question.id)}
					<li class="question" data-testid="link-question">
						<figure>
							{#if question.new_face}<img
									src={faceSrc(question.new_face)}
									alt="New worker at {question.new_pump}"
								/>{/if}
							<figcaption>
								<strong>{question.new_name ?? 'New worker'}</strong>
								<span>{question.new_pump}, {formatDate(question.created_at)}</span>
							</figcaption>
						</figure>
						<figure>
							{#if question.other_face}<img
									src={faceSrc(question.other_face)}
									alt="Worker at {question.other_pump}"
								/>{/if}
							<figcaption>
								<strong>{question.other_name ?? 'Worker'}</strong>
								<span>{question.other_pump}</span>
							</figcaption>
						</figure>
						<form method="POST" action="?/link" class="question-actions" use:enhance>
							<input type="hidden" name="candidate" value={question.id} />
							<button
								class="button button--primary"
								name="answer"
								value="same"
								data-testid="link-same">Same person</button
							>
							<button class="button button--secondary" name="answer" value="different"
								>Different people</button
							>
						</form>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<form class="filter-bar" method="GET" role="search">
		<SearchField value={data.q} placeholder="Gang, pump, plant or area" testId="gang-search" />
		<div class="filter-actions">
			{#if data.q}<a class="button button--ghost" href={pagePath}>Clear</a>{/if}
		</div>
	</form>

	{#if !data.gangs.length}
		<EmptyState
			title={data.q ? 'No gang matches' : 'No gangs yet'}
			description={data.q
				? 'Try a pump code, a plant or an area.'
				: 'Gangs appear after the first shift photo in an area with gangs switched on.'}
		/>
	{/if}

	{#each groups as area (area.name)}
		<section class="area-group" aria-label={area.name}>
			<h2>{area.name}</h2>
			{#each area.plants as plant (plant.name)}
				<h3>{plant.name}</h3>
				<ul class="gang-rows">
					{#each plant.gangs as gang (gang.id)}
						<li class="gang-row" data-testid="gang-row" data-code={gang.code}>
							<span class="faces" aria-hidden="true">
								{#each gang.faces as face (face)}<img
										src={faceSrc(face)}
										alt=""
										loading="lazy"
									/>{/each}
							</span>
							<div class="who">
								<a href={gangHref(gang.id)}
									><strong>Gang {gang.code}{gang.name ? ` (${gang.name})` : ''}</strong></a
								>
								<span class="muted"
									>First seen at {gang.first_pump_code ?? 'a pump'}, {formatDateTime(
										gang.created_at
									)}</span
								>
							</div>
							<div class="last">
								{#if gang.last_day}
									<span>Last at <strong>{gang.last_pump_code}</strong></span>
									<span class="muted">{formatDate(gang.last_day)}</span>
								{:else}<span class="muted">No shift yet</span>{/if}
							</div>
							<div class="counts">
								<span
									><strong>{gang.days_this_month}</strong>
									{gang.days_this_month === 1 ? 'day' : 'days'} this month</span
								>
								<span class="muted"
									>{gang.shifts}
									{gang.shifts === 1 ? 'shift' : 'shifts'} at {gang.pumps_worked}
									{gang.pumps_worked === 1 ? 'pump' : 'pumps'}</span
								>
							</div>
						</li>
					{/each}
				</ul>
			{/each}
		</section>
	{/each}
</div>

<style>
	.questions {
		display: grid;
		gap: var(--space-3);
		margin-bottom: var(--space-5);
		border-left: 4px solid var(--status-attention, #c98a00);
	}
	.questions h2 {
		margin: 0;
	}
	.question-list {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.question {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 9rem)) minmax(0, 1fr);
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3);
		background: var(--surface-subtle);
		border-radius: var(--radius-md);
	}
	.question figure {
		display: grid;
		gap: var(--space-1);
		margin: 0;
	}
	.question img {
		width: 100%;
		aspect-ratio: 1;
		object-fit: cover;
		border-radius: var(--radius-md);
	}
	.question figcaption {
		display: grid;
		font-size: var(--text-sm);
	}
	.question figcaption span,
	.muted {
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.question-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.area-group {
		margin-top: var(--space-5);
	}
	.area-group h2 {
		margin: 0 0 var(--space-2);
		font-size: var(--text-xl);
	}
	.area-group h3 {
		margin: var(--space-3) 0 var(--space-2);
		color: var(--ink-muted);
		font-size: var(--text-base);
	}
	.gang-rows {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.gang-row {
		display: grid;
		grid-template-columns: 9rem minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr);
		align-items: center;
		gap: var(--space-4);
		padding: var(--space-3) var(--space-4);
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.gang-row > div {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.faces {
		display: flex;
	}
	.faces img {
		width: 2.25rem;
		height: 2.25rem;
		margin-left: -0.6rem;
		object-fit: cover;
		border: 2px solid var(--brand-white);
		border-radius: 50%;
	}
	.faces img:first-child {
		margin-left: 0;
	}
	@media (max-width: 40rem) {
		.question {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.question-actions {
			grid-column: 1 / -1;
		}
		.question-actions .button {
			flex: 1;
		}
		.gang-row {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--space-2);
		}
	}
</style>
