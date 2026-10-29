<script lang="ts">
	import PeopleList from '$lib/components/PeopleList.svelte';

	let { data, form } = $props();
</script>

<svelte:head><title>Vendor people | Face Attendance</title></svelte:head>
<PeopleList
	{data}
	{form}
	eyebrow="Vendor workspace"
	intro="Workers at your pumps. The operator names each worker; correct a name here if needed."
/>
