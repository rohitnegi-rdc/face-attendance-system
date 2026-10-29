<script lang="ts">
	// "Same people?" on Fix attendance: the camera saw new faces at the shift end. One question per
	// new face, "Who is this from the shift start?", with the start faces beside it to tap and
	// "Someone new" for a real newcomer. The likeliest face is picked already, so a right guess
	// needs one tap on Save. Each pair becomes one worker (samePeople.ts).
	import { enhance } from '$app/forms';
	import Check from '@lucide/svelte/icons/check';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import { showErrorToast } from '$lib/toast.svelte';
	import type { SamePeople } from '$lib/server/samePeople';

	let { same, action }: { same: SamePeople; action: string } = $props();

	// End worker id -> start worker id picked for them ('' = someone new).
	let picked = $derived<Record<string, string>>(
		Object.fromEntries(same.endOnly.map((worker) => [worker.id, same.suggested[worker.id] ?? '']))
	);
	let saving = $state(false);
	const count = $derived(Object.values(picked).filter(Boolean).length);
	const startLabel = (id: string) => same.startOnly.find((w) => w.id === id)?.label ?? '';
	// The suggested face first, so the likeliest answer is the first thing the eye meets.
	const choicesFor = (endId: string) => {
		const best = same.suggested[endId];
		return best
			? [
					...same.startOnly.filter((w) => w.id === best),
					...same.startOnly.filter((w) => w.id !== best)
				]
			: same.startOnly;
	};

	// A start face picked for another new face moves here; that one goes back to "Someone new".
	function pick(endId: string, startId: string) {
		const next = { ...picked };
		if (startId) {
			for (const [other, chosen] of Object.entries(next)) {
				if (other !== endId && chosen === startId) next[other] = '';
			}
		}
		next[endId] = startId;
		picked = next;
	}
</script>

<section class="same" id="same-people" aria-labelledby="same-title" data-testid="same-people">
	<header class="same__head">
		<h2 id="same-title">Same people?</h2>
		<p>
			The camera saw {same.endOnly.length}
			{same.endOnly.length === 1 ? 'new face' : 'new faces'} at the shift end. If one was already there
			at the shift start, tap that person. If not, leave <strong>Someone new</strong>.
		</p>
	</header>

	<form
		method="POST"
		{action}
		use:enhance={() => {
			saving = true;
			return async ({ result, update }) => {
				saving = false;
				if (result.type === 'error') showErrorToast();
				await update({ reset: false });
			};
		}}
	>
		<ol class="questions">
			{#each same.endOnly as worker, i (worker.id)}
				{@const chosen = picked[worker.id]}
				<li class="question" data-testid="same-pair">
					<div class="question__face">
						<span class="face face--big">
							{#if worker.faceUrl}<img src={worker.faceUrl} alt="" loading="lazy" />{/if}
						</span>
						<span class="question__who">
							<small>New face {i + 1} · shift end</small>
							<strong>{worker.label}</strong>
						</span>
					</div>
					<fieldset class="choices">
						<legend>Who is this from the shift start?</legend>
						<div class="choices__grid">
							{#each choicesFor(worker.id) as start (start.id)}
								<label class="choice" class:choice--on={chosen === start.id}>
									<input
										type="radio"
										name="pair_{worker.id}"
										value={start.id}
										checked={chosen === start.id}
										onchange={() => pick(worker.id, start.id)}
									/>
									<span class="face">
										{#if start.faceUrl}<img src={start.faceUrl} alt="" loading="lazy" />{/if}
										{#if chosen === start.id}<span class="tick"><Check size={16} /></span>{/if}
									</span>
									<span class="choice__name">{start.label}</span>
									{#if same.suggested[worker.id] === start.id}<span class="choice__hint"
											>Looks alike</span
										>{/if}
								</label>
							{/each}
							<label class="choice" class:choice--on={!chosen}>
								<input
									type="radio"
									name="pair_{worker.id}"
									value=""
									checked={!chosen}
									onchange={() => pick(worker.id, '')}
								/>
								<span class="face face--new"><UserPlus size={26} /></span>
								<span class="choice__name">Someone new</span>
							</label>
						</div>
					</fieldset>
					<p class="question__result" class:question__result--same={chosen}>
						{chosen ? `Same person as ${startLabel(chosen)}` : 'Stays a new worker'}
					</p>
				</li>
			{/each}
		</ol>
		<div class="same__foot">
			<button
				class="button button--primary"
				type="submit"
				disabled={!count || saving}
				data-testid="same-merge"
			>
				<Check size={18} />
				{saving
					? 'Saving...'
					: count
						? `Save: ${count} same ${count === 1 ? 'person' : 'people'}`
						: 'Tap a face to save'}
			</button>
			<p>They then count for the full shift. You can undo it on the worker's page.</p>
		</div>
	</form>
</section>

<style>
	.same {
		display: grid;
		gap: var(--space-3);
		margin-bottom: var(--space-5);
		padding: var(--space-4);
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-left: 4px solid #b45309;
		border-radius: var(--radius-md);
	}
	.same__head h2 {
		margin: 0 0 var(--space-1);
		font-size: var(--text-lg);
	}
	.same__head p {
		margin: 0;
		max-width: 46rem;
		color: var(--ink-muted);
	}
	.questions {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	/* Phone: the new face on top, the start faces below it. Wide: side by side. */
	.question {
		display: grid;
		gap: var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px solid var(--brand-mist);
	}
	.question__face {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
	.question__who {
		display: grid;
		gap: 0.15rem;
		line-height: 1.25;
	}
	.question__who small {
		color: #92400e;
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.question__result {
		margin: 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
		font-weight: 700;
	}
	.question__result--same {
		color: #047857;
	}
	.face {
		position: relative;
		display: grid;
		flex: none;
		width: 4.5rem;
		height: 4.5rem;
		place-items: center;
		overflow: hidden;
		color: var(--ink-muted);
		background: var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.face img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.face--big {
		width: 6rem;
		height: 6rem;
		border: 3px solid #f59e0b;
	}
	.tick {
		position: absolute;
		right: 0.2rem;
		bottom: 0.2rem;
		display: grid;
		width: 1.5rem;
		height: 1.5rem;
		place-items: center;
		color: #fff;
		background: var(--brand-teal);
		border-radius: 999px;
	}
	.choices {
		margin: 0;
		padding: 0;
		border: 0;
	}
	.choices legend {
		margin-bottom: var(--space-2);
		padding: 0;
		font-weight: 700;
	}
	.choices__grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr));
		gap: var(--space-2);
	}
	.choice {
		position: relative;
		display: grid;
		justify-items: center;
		align-content: start;
		gap: 0.3rem;
		padding: var(--space-2) var(--space-1);
		text-align: center;
		cursor: pointer;
		border: 2px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.choice input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.choice:hover {
		border-color: var(--brand-steel);
	}
	.choice:focus-within {
		outline: 2px solid var(--brand-teal);
		outline-offset: 2px;
	}
	.choice--on {
		background: #ecfdf5;
		border-color: var(--brand-teal);
	}
	.choice__name {
		font-size: var(--text-xs);
		font-weight: 700;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}
	.choice__hint {
		padding: 0.05rem 0.4rem;
		color: #92400e;
		font-size: 0.7rem;
		font-weight: 700;
		background: #fef3c7;
		border-radius: 999px;
	}
	.same__foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px solid var(--brand-mist);
	}
	.same__foot p {
		margin: 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	@media (max-width: 30rem) {
		.same__foot .button {
			width: 100%;
		}
	}
	@media (min-width: 48rem) {
		.question {
			grid-template-columns: 12rem minmax(0, 1fr);
			align-items: start;
			column-gap: var(--space-5);
		}
		.question__face {
			flex-direction: column;
			align-items: flex-start;
		}
		.question__result {
			grid-column: 2;
		}
	}
</style>
