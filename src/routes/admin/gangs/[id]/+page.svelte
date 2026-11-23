<script lang="ts">
	import GangPage from '$lib/components/GangPage.svelte';

	let { data, form } = $props();
</script>

<GangPage {data} {form} base="admin" />
