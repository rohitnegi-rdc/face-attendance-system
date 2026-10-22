<script lang="ts">
	import FraudWatchList from '$lib/components/FraudWatchList.svelte';

	let { data } = $props();
</script>

<svelte:head><title>Fraud | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Vendor</p>
			<h1>Fraud</h1>
			<p>
				Workers from your pumps whose face was also found at another pump in the same Area. The
				platform admin checks each case and decides.
			</p>
		</div>
	</header>

	<FraudWatchList cases={data.cases} testId="vendor-fraud" />
</div>
