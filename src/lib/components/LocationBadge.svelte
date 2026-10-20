<script lang="ts">
	// Shift start location check result, shown under a session's status. Nothing when the start
	// was within range or the area does not use the check.
	let { status }: { status: string | null | undefined } = $props();
	const labels: Record<string, string> = {
		pending: 'Location: waiting for approval',
		approved: 'Location: approved',
		rejected: 'Location: rejected'
	};
</script>

{#if status && labels[status]}
	<small class="location-badge location-badge--{status}">{labels[status]}</small>
{/if}

<style>
	.location-badge {
		display: block;
		width: fit-content;
		margin-top: 4px;
		padding: 1px 6px;
		font-size: var(--text-xs, 0.75rem);
		border-radius: 999px;
	}
	.location-badge--pending {
		color: #7a4f00;
		background: #ffe9b0;
	}
	.location-badge--approved {
		color: #0b5a3c;
		background: #d7f0e2;
	}
	.location-badge--rejected {
		color: #8a1c1c;
		background: #f9d6d6;
	}
</style>
