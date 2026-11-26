<script lang="ts">
	// Back to the page this one was opened from (backNav.ts), labelled with that page's name. The
	// fallback (`href`, `label`) is where back goes when the page was opened directly: a link from
	// an email, a bookmark, a new tab.
	import { page } from '$app/state';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { backFor } from '$lib/backNav';

	let { href, label, testId }: { href: string; label: string; testId?: string } = $props();

	// Read after hydration (sessionStorage is in the browser only) and again when the page changes
	// to another page of the same route (a different pump).
	let previous = $state<{ href: string; label: string } | null>(null);
	$effect(() => {
		previous = backFor(page.url.pathname);
	});
	const target = $derived(previous ?? { href, label });
</script>

<a class="back-link" href={target.href} data-testid={testId ?? 'back-link'}
	><ArrowLeft size={17} aria-hidden="true" /> {target.label}</a
>

<style>
	.back-link {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		align-self: flex-start;
		justify-self: start;
		min-height: 2.75rem;
		margin-bottom: var(--space-2);
		color: var(--brand-teal);
		font-size: var(--text-sm);
		font-weight: 600;
		text-decoration: none;
	}
	.back-link:hover {
		text-decoration: underline;
	}
</style>
