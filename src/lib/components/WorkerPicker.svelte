<script lang="ts">
	// Choose a worker of one pump by face: each worker shows their latest face, so the admin
	// compares the face being fixed with the candidates side by side. Posts `person_id` (empty for
	// "New worker", which also posts `name`). Used by the admin face fixes (faceFixes.ts).
	type Worker = { id: string; label: string; previewUrl: string | null };

	let {
		workers,
		allowNew = true,
		newLabel = 'New worker',
		nameRequired = false
	}: {
		workers: Worker[];
		allowNew?: boolean;
		newLabel?: string;
		nameRequired?: boolean;
	} = $props();

	let chosen = $state<string | null>(null);
</script>

<fieldset class="picker">
	<legend class="sr-only">Choose the worker</legend>
	<div class="picker__list">
		{#if allowNew}
			<label class="picker__option" class:picker__option--chosen={chosen === ''}>
				<input type="radio" name="person_id" value="" bind:group={chosen} required />
				<span class="picker__noface">+</span>
				<span>{newLabel}</span>
			</label>
		{/if}
		{#each workers as worker (worker.id)}
			<label class="picker__option" class:picker__option--chosen={chosen === worker.id}>
				<input type="radio" name="person_id" value={worker.id} bind:group={chosen} required />
				{#if worker.previewUrl}
					<img src={worker.previewUrl} alt="" loading="lazy" />
				{:else}
					<span class="picker__noface">No face</span>
				{/if}
				<span>{worker.label}</span>
			</label>
		{/each}
	</div>
	{#if allowNew && chosen === ''}
		<label class="field">
			<span
				>Name {#if !nameRequired}<small>Optional</small>{/if}</span
			>
			<input name="name" maxlength="60" required={nameRequired} autocomplete="off" />
		</label>
	{/if}
	{#if !workers.length && !allowNew}
		<p class="picker__empty">No other worker at this pump.</p>
	{/if}
</fieldset>

<style>
	.picker {
		display: grid;
		gap: var(--space-2);
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.picker__list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr));
		gap: var(--space-2);
		max-height: 17rem;
		overflow-y: auto;
	}
	.picker__option {
		position: relative;
		display: grid;
		gap: var(--space-1);
		padding: var(--space-1);
		font-size: var(--text-xs);
		font-weight: 600;
		text-align: center;
		border: 2px solid var(--brand-mist);
		border-radius: var(--radius-md);
		cursor: pointer;
	}
	.picker__option--chosen {
		border-color: var(--brand-primary, #1d4ed8);
	}
	.picker__option input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.picker__option img,
	.picker__noface {
		width: 100%;
		aspect-ratio: 1;
		object-fit: cover;
		border-radius: var(--radius-sm, 4px);
		background: var(--surface-muted);
	}
	.picker__noface {
		display: grid;
		place-items: center;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.picker__empty {
		margin: 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
</style>
