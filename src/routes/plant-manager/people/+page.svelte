<script lang="ts">
	import PeopleList from '$lib/components/PeopleList.svelte';

	let { data, form } = $props();
</script>

<svelte:head><title>Plant workers | Face Attendance</title></svelte:head>
<PeopleList
	{data}
	{form}
	eyebrow="Plant manager"
	intro="Workers at the pumps of your plants. The operator names each worker; correct a name here if needed."
/>
