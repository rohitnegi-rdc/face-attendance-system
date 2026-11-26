<script lang="ts">
	import { assets } from '$app/paths';
	import '$lib/styles/global.css';
	import Toaster from '$lib/components/Toaster.svelte';
	import { beforeNavigate } from '$app/navigation';
	import { recordNavigation } from '$lib/backNav';

	let { children } = $props();

	// Back links return to the previous page (BackLink.svelte): remember where each page came from,
	// with the leaving page's tab title as the label.
	beforeNavigate(({ from, to, type }) => {
		if (from && to) recordNavigation(from.url, to.url, document.title, type);
	});
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
