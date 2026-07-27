<script lang="ts">
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Clock3 from '@lucide/svelte/icons/clock-3';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import CircleMinus from '@lucide/svelte/icons/circle-minus';

	let {
		label = '',
		tone = 'pending',
		children
	} = $props<{
		label?: string;
		tone?: 'success' | 'active' | 'pending' | 'critical' | 'attention' | 'neutral';
		children?: import('svelte').Snippet;
	}>();

	let Icon = $derived(
		tone === 'success' || tone === 'active'
			? CircleCheck
			: tone === 'critical' || tone === 'attention'
				? TriangleAlert
				: tone === 'pending'
					? Clock3
					: CircleMinus
	);
</script>

<span class="status-badge status-badge--{tone}">
	<Icon size={13} aria-hidden="true" />
	{#if children}{@render children()}{:else}{label}{/if}
</span>
