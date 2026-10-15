<script lang="ts">
	import { onMount } from 'svelte';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import X from '@lucide/svelte/icons/x';
	import { dismissToast, showErrorToast, toasts } from '$lib/toast.svelte';

	// Last line of defence: an error no page handled still reaches the user.
	onMount(() => {
		const onRejection = (event: PromiseRejectionEvent) => {
			console.error('Unhandled rejection', event.reason);
			showErrorToast();
		};
		const onError = (event: ErrorEvent) => {
			console.error('Unhandled error', event.error ?? event.message);
			showErrorToast();
		};
		window.addEventListener('unhandledrejection', onRejection);
		window.addEventListener('error', onError);
		return () => {
			window.removeEventListener('unhandledrejection', onRejection);
			window.removeEventListener('error', onError);
		};
	});
</script>

<div class="toaster" aria-live="assertive">
	{#each toasts as toast (toast.id)}
		<div class="toast" role="alert" data-testid="error-toast">
			<CircleAlert size={20} aria-hidden="true" />
			<div class="toast-text">
				<strong>{toast.message}</strong>
				{#if toast.detail}<span>{toast.detail}</span>{/if}
			</div>
			<button type="button" aria-label="Dismiss" onclick={() => dismissToast(toast.id)}>
				<X size={18} aria-hidden="true" />
			</button>
		</div>
	{/each}
</div>

<style>
	.toaster {
		position: fixed;
		inset: auto var(--space-4) var(--space-4) var(--space-4);
		z-index: var(--z-toast);
		display: grid;
		justify-items: center;
		gap: var(--space-2);
		pointer-events: none;
	}

	.toast {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		width: min(100%, 28rem);
		padding: var(--space-3) var(--space-4);
		color: var(--brand-white);
		background: var(--ink-strong);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		pointer-events: auto;
	}

	.toast-text {
		display: grid;
		flex: 1;
		gap: var(--space-1);
	}

	.toast-text span {
		font-size: var(--text-sm);
		opacity: 0.85;
	}

	.toast button {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		margin: calc(var(--space-1) * -1) calc(var(--space-2) * -1) 0 0;
		color: inherit;
		background: none;
		border: 0;
		border-radius: var(--radius-md);
		cursor: pointer;
	}
</style>
