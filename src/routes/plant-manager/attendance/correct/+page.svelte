<script lang="ts">
	// The same Fix attendance as the admin's (FixAttendance.svelte), for the manager's plants.
	import { resolve } from '$app/paths';
	import FixAttendance from '$lib/components/FixAttendance.svelte';

	let { data, form } = $props();
</script>

<FixAttendance {data} {form} backHref={resolve('/plant-manager/attendance')} />
