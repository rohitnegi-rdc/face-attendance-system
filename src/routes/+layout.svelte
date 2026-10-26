<script lang="ts">
	import { assets } from '$app/paths';
	import '$lib/styles/global.css';
	import Toaster from '$lib/components/Toaster.svelte';

	let { children } = $props();
</script>

<svelte:head>
	<!-- The RDC truck (static/icons, cut from assets/logo.png). -->
	<link rel="icon" type="image/png" sizes="32x32" href="{assets}/icons/favicon-32.png" />
	<link rel="icon" type="image/png" sizes="48x48" href="{assets}/icons/favicon-48.png" />
	<link rel="icon" type="image/png" sizes="96x96" href="{assets}/icons/favicon-96.png" />
	<title>Face Attendance</title>
	<meta
		name="description"
		content="Group photo attendance for pump operators, vendors, and administrators."
	/>
</svelte:head>

<a class="skip-link" href="#main-content">Skip to main content</a>
{@render children()}
<Toaster />
