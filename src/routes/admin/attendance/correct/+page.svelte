<script lang="ts">
	// The same Fix attendance as the plant manager's (FixAttendance.svelte).
	import { resolve } from '$app/paths';
	import FixAttendance from '$lib/components/FixAttendance.svelte';

	let { data, form } = $props();
</script>

<FixAttendance {data} {form} backHref={resolve(`/admin/attendance?day=${data.day}`)} />
