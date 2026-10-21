<script lang="ts">
	import PhotoBackupList from '$lib/components/PhotoBackupList.svelte';

	let { data } = $props();
</script>

<svelte:head><title>Kept photos | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Platform operations</p>
			<h1>Kept photos</h1>
			<p>
				The original photo from every pump, saved before processing. A photo that failed or was
				flagged as fraud keeps its copy here, even after the pump tapped Retry. Newest first.
			</p>
		</div>
	</header>

	<PhotoBackupList items={data.items} showPumpLink />
</div>
