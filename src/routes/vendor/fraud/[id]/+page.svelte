<script lang="ts">
	import { resolve } from '$app/paths';
	import FraudCaseDetail from '$lib/components/FraudCaseDetail.svelte';

	let { data } = $props();
</script>

<svelte:head><title>Fraud case {data.fraudCase.refused.pump} | Face Attendance</title></svelte:head>

<FraudCaseDetail fraudCase={data.fraudCase} backHref={resolve('/vendor/fraud')} backLabel="Fraud" />
