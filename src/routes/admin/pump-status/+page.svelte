<script lang="ts">
	import PumpStatusBoard from '$lib/components/PumpStatusBoard.svelte';
	let { data, form } = $props();
</script>

<svelte:head><title>Pump status | Face Attendance</title></svelte:head>
<PumpStatusBoard {data} {form} />
