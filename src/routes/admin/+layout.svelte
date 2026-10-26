<script lang="ts">
	import { resolve } from '$app/paths';
	import AppShell from '$lib/components/AppShell.svelte';
	import { formatDateTime } from '$lib/date';

	let { data, children } = $props();
</script>

<AppShell role="admin" userEmail={data.user?.email} navCounts={data.navCounts}>
	{#if data.testMode.on}
		<p class="alert alert--error test-mode-banner" role="status" data-testid="test-mode-banner">
			<strong>Test mode is on</strong>{#if data.testMode.since}
				since {formatDateTime(data.testMode.since)}{/if}{#if data.testMode.by}
				({data.testMode.by}){/if}. The cross-pump fraud check is off, so the same person can be
			counted at two pumps, and fraud alert and location approval emails are not sent.
			<a href={resolve('/admin/settings')}>Turn test mode off</a>
		</p>
	{/if}
	{@render children()}
</AppShell>

<style>
	.test-mode-banner {
		margin: 0 0 var(--space-4);
	}
</style>
