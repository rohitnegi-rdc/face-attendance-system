<script lang="ts">
	import PumpShell from '$lib/components/PumpShell.svelte';

	let { data, children } = $props();
</script>

<PumpShell userEmail={data.user?.email} guideDone={data.guideDone}>
	{@render children()}
</PumpShell>
