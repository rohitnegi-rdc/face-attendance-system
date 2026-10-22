<script lang="ts">
	import ScanFace from '@lucide/svelte/icons/scan-face';
	import X from '@lucide/svelte/icons/x';

	// A "Face" button that opens the worker's face in a dialog. The image is requested only when
	// opened, so a long list of workers does not load every face (crops are ~17 KB each).
	let { url, label }: { url: string; label: string } = $props();

	let dialog: HTMLDialogElement;
	let opened = $state(false);

	function open() {
		opened = true;
		dialog.showModal();
	}
</script>

<button
	class="face-peek"
	type="button"
	onclick={open}
	aria-label="View face of {label}"
	title="View face"
	data-testid="face-peek"
>
	<ScanFace size={16} aria-hidden="true" />
</button>

<dialog bind:this={dialog} class="face-peek__dialog" aria-label="Face of {label}">
	<div class="face-peek__header">
		<strong>{label}</strong>
		<button class="icon-button" type="button" title="Close" onclick={() => dialog.close()}>
			<X size={18} />
		</button>
	</div>
	{#if opened}<img src={url} alt="Face of {label}" />{/if}
</dialog>

<style>
	.face-peek {
		display: inline-grid;
		flex: none;
		width: 2rem;
		height: 2rem;
		place-items: center;
		padding: 0;
		color: var(--brand-teal);
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: 999px;
		cursor: pointer;
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
	.face-peek__dialog img {
		display: block;
		width: 100%;
		aspect-ratio: 1;
		object-fit: contain;
		background: var(--surface-muted);
	}
</style>
