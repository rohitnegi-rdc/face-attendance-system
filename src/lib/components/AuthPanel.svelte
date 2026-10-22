<script lang="ts">
	// The signed-out frame: sign in, forgot password, reset password. A card on wide screens,
	// plain white full width on a phone.
	import type { Snippet } from 'svelte';
	import ScanFace from '@lucide/svelte/icons/scan-face';
	let { labelledby, children }: { labelledby: string; children: Snippet } = $props();
</script>

<main id="main-content" class="auth-page">
	<section class="auth-panel" aria-labelledby={labelledby}>
		<div class="product-lockup">
			<span class="product-mark" aria-hidden="true"><ScanFace size={28} strokeWidth={1.8} /></span>
			<div>
				<strong>Face Attendance</strong>
				<span>Workforce operations</span>
			</div>
		</div>
		{@render children()}
	</section>
</main>

<style>
	.auth-page {
		display: grid;
		min-height: 100vh;
		place-items: center;
		padding: var(--space-6) var(--space-4);
		background: var(--surface-subtle);
	}
	.auth-panel {
		width: min(100%, 27rem);
		padding: clamp(1.5rem, 5vw, 2.5rem);
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
	}
	.product-lockup {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
	.product-lockup > div {
		display: grid;
		line-height: 1.25;
	}
	.product-lockup strong {
		color: var(--ink-strong);
		font-size: var(--text-lg);
	}
	.product-lockup span:last-child {
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.product-mark {
		display: grid;
		width: 2.75rem;
		height: 2.75rem;
		place-items: center;
		color: var(--primary-on);
		background: var(--brand-teal);
		border-radius: var(--radius-md);
	}
	/* Shared by the pages inside the frame. */
	.auth-panel :global(.auth-heading) {
		margin: var(--space-8) 0 var(--space-6);
	}
	.auth-panel :global(.auth-heading h1) {
		margin: 0;
		font-size: var(--text-3xl);
	}
	.auth-panel :global(.auth-heading p) {
		margin: var(--space-2) 0 0;
		color: var(--ink-muted);
	}
	.auth-panel :global(.auth-form) {
		display: grid;
		gap: var(--space-5);
	}
	.auth-panel :global(.auth-submit) {
		width: 100%;
		min-height: 2.75rem;
	}
	.auth-panel :global(.auth-back) {
		display: inline-flex;
		align-items: center;
		min-height: 2.75rem;
		margin-top: var(--space-4);
		color: var(--brand-teal);
		font-weight: 700;
	}
	@media (max-width: 34rem) {
		.auth-page {
			align-items: start;
			padding-top: max(4rem, 14vh);
			background: var(--brand-white);
		}
		.auth-panel {
			padding: 0;
			border: 0;
			box-shadow: none;
		}
	}
</style>
