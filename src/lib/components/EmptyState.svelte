<script lang="ts">
	import Inbox from '@lucide/svelte/icons/inbox';

	let { title, description } = $props<{
		title: string;
		description: string;
	}>();
</script>

<div class="empty-state">
	<Inbox size={28} aria-hidden="true" />
	<div>
		<h2>{title}</h2>
		<p>{description}</p>
	</div>
</div>
