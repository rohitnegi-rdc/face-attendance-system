<script lang="ts">
	import { resolve } from '$app/paths';
	import AppShell from '$lib/components/AppShell.svelte';

	let { data, children } = $props();
</script>

<AppShell role="admin" userEmail={data.user?.email}>
	{#if data.fraudCheckDisabled}
		<p class="alert alert--error test-mode-banner" role="status">
			Test mode: the cross-pump fraud check is off. The same person can be counted at two pumps.
			<a href={resolve('/admin/settings')}>Turn it back on</a>
		</p>
	{/if}
	{@render children()}
</AppShell>

<style>
	.test-mode-banner {
		margin: 0 0 var(--space-4);
	}
</style>
