<script lang="ts">
	// The RDC mixer truck (assets/logo.png, cropped to static/icons/logo-wide.png), the app's mark
	// in every header and on the sign-in page. Decorative: the name always sits beside it.
	import { assets } from '$app/paths';
	let { height = 2 }: { height?: number } = $props();
</script>

<img
	class="rdc-logo"
	src="{assets}/icons/logo-wide.png"
	alt=""
	width="240"
	height="115"
	style:height="{height}rem"
/>

<style>
	.rdc-logo {
		display: block;
		flex: none;
		width: auto;
	}
</style>
