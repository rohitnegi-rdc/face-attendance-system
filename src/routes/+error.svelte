<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';

	const title = $derived(
		page.status === 404
			? 'Page not found'
			: page.status === 403
				? 'You do not have access to this page'
				: 'Something went wrong'
	);
</script>

<svelte:head>
	<title>{title} · Face Attendance</title>
</svelte:head>

<main id="main-content" class="error-page" data-testid="error-page">
	<p class="error-code">Error {page.status}</p>
	<h1>{title}</h1>
	{#if page.status >= 500}
		<p>{page.error?.message}</p>
		{#if page.error?.errorId}
			<p class="error-ref">
				Tell the admin this reference: <strong data-testid="error-ref">{page.error.errorId}</strong>
			</p>
		{/if}
	{:else}
		<p>{page.error?.message}</p>
	{/if}
	<p class="error-actions">
		<a class="button button--primary" href={resolve('/')}>Go to the home page</a>
		<button type="button" class="button" onclick={() => history.back()}>Go back</button>
	</p>
</main>

<style>
	.error-page {
		display: grid;
		gap: var(--space-2);
		max-width: 32rem;
		margin: 0 auto;
		padding: var(--space-16) var(--space-4);
	}

	.error-code {
		margin: 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}

	.error-ref strong {
		font-family: ui-monospace, monospace;
	}

	.error-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-4);
	}
</style>
