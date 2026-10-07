<script lang="ts">
	import AppShell from '$lib/components/AppShell.svelte';
	let { data, children } = $props();
</script>

<AppShell role="plant-manager" userEmail={data.user?.email}>
	{@render children()}
</AppShell>
