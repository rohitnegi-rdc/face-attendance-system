<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import '$lib/styles/global.css';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Face Attendance</title>
	<meta
		name="description"
		content="Group photo attendance for pump operators, vendors, and administrators."
	/>
</svelte:head>

<a class="skip-link" href="#main-content">Skip to main content</a>
{@render children()}
