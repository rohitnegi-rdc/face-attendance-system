<script lang="ts">
	import GangsList from '$lib/components/GangsList.svelte';

	let { data, form } = $props();
</script>

<svelte:head><title>Gangs | Face Attendance</title></svelte:head>

<GangsList {data} {form} base="admin" />
