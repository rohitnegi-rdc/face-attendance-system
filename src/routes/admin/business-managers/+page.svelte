<script lang="ts">
	// The page is shared with the other business role: src/lib/components/BusinessRolePage.svelte.
	import BusinessRolePage from '$lib/components/BusinessRolePage.svelte';

	let { data, form } = $props();
</script>

<BusinessRolePage role="manager" {data} {form} />
