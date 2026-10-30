<script lang="ts">
	import AppShell from '$lib/components/AppShell.svelte';
	let { data, children } = $props();
</script>

<AppShell
	role="plant-manager"
	userEmail={data.user?.email}
	isMonitor={data.isMonitor}
	monitorOnly={data.monitorOnly}
	navCounts={data.navCounts}
>
	{@render children()}
</AppShell>
