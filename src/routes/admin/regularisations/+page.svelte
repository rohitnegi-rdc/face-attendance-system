<script lang="ts">
	import MissedDays from '$lib/components/MissedDays.svelte';

	let { data, form } = $props();
</script>

<svelte:head><title>Missed days | Face Attendance</title></svelte:head>

<MissedDays role="admin" {data} {form} />
