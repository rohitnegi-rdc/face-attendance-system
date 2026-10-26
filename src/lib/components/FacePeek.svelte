<script lang="ts">
	import ScanFace from '@lucide/svelte/icons/scan-face';
	import X from '@lucide/svelte/icons/x';

	// The worker's face shown beside their name, so a reader confirms name and face together; a tap
	// opens it large. Loaded lazily from the cached face route (~30 KB, kept a day by the browser),
	// so a long list only fetches the faces scrolled into view. No face yet: the icon instead.
	let { url, label }: { url: string; label: string } = $props();

	let dialog: HTMLDialogElement;
	let missing = $state(false);
</script>

<button
	class="face-peek"
	type="button"
	onclick={() => dialog.showModal()}
	aria-label="View face of {label}"
	title="View face"
	data-testid="face-peek"
>
	{#if missing}
		<ScanFace size={16} aria-hidden="true" />
	{:else}
		<img src={url} alt="" loading="lazy" decoding="async" onerror={() => (missing = true)} />
	{/if}
</button>

<dialog bind:this={dialog} class="face-peek__dialog" aria-label="Face of {label}">
	<div class="face-peek__header">
		<strong>{label}</strong>
		<button class="icon-button" type="button" title="Close" onclick={() => dialog.close()}>
			<X size={18} />
		</button>
	</div>
	{#if missing}<p class="face-peek__none">No face saved for this worker yet.</p>{:else}<img
			src={url}
			alt="Face of {label}"
		/>{/if}
</dialog>

<style>
	.face-peek {
		display: inline-grid;
		flex: none;
		width: 2.25rem;
		height: 2.25rem;
		place-items: center;
		padding: 0;
		overflow: hidden;
		color: var(--brand-teal);
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: 999px;
		cursor: pointer;
	}
	.face-peek img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.face-peek__none {
		margin: 0;
		padding: var(--space-4);
		color: var(--ink-muted);
	}
	.face-peek:hover,
	.face-peek:focus-visible {
		border-color: var(--brand-teal);
	}
	.face-peek__dialog {
		width: min(22rem, calc(100vw - 2rem));
		padding: 0;
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-lg);
	}
	.face-peek__dialog::backdrop {
		background: rgb(18 35 38 / 62%);
	}
	.face-peek__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		border-bottom: 1px solid var(--brand-mist);
	}
	.face-peek__dialog > img {
		display: block;
		width: 100%;
		aspect-ratio: 1;
		object-fit: contain;
		background: var(--surface-muted);
	}
</style>
