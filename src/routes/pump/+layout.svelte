<script lang="ts">
	import PumpShell from '$lib/components/PumpShell.svelte';

	let { data, children } = $props();
</script>

<PumpShell userEmail={data.user?.email}>
	{@render children()}
</PumpShell>
