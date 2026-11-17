<script lang="ts">
	// What a regularisation request says, shown inline wherever it is decided or listed: the reason,
	// the voice note, the workers claimed, who asked and when, and (for admins) the approver.
	import { base } from '$app/paths';
	import { REASON_TEXT } from '$lib/regularisationLabels';
	import type { RequestRow } from '$lib/server/regularisation';

	let { r, role }: { r: RequestRow; role: 'admin' | 'plant-manager' } = $props();

	const voiceUrl = $derived(`${base}/api/regularisation/${r.id}/voice`);
	const asker = $derived(
		r.requestedByRole === 'pump'
			? 'The pump operator'
			: `${r.requestedByName}${r.requestedByRole === 'plant_manager' ? ' (plant manager)' : ' (admin)'}`
	);
</script>

<div class="evidence">
	<p class="reason">
		<span aria-hidden="true">{REASON_TEXT[r.reason]?.icon}</span>
		<strong>{REASON_TEXT[r.reason]?.en ?? r.reason}</strong>{#if r.note}: {r.note}{/if}
	</p>
	{#if r.hasVoice}
		<audio controls preload="none" src={voiceUrl} data-testid="reg-voice">
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- a file, already under base -->
			<a href={voiceUrl}>Play the voice note</a>
		</audio>
	{/if}
	<p class="workers">
		<span class="muted">{r.workers.length} {r.workers.length === 1 ? 'worker' : 'workers'}:</span>
		{r.workers.join(', ')}
	</p>
	<p class="muted small">
		Asked by {asker} on {r.requestedAt}{role === 'admin'
			? ` · Approver: ${r.approverName ?? 'Admins (plant has no business manager)'}`
			: ''}
	</p>
</div>

<style>
	.evidence {
		display: grid;
		gap: var(--space-1);
	}
	.evidence p {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.reason span {
		margin-right: var(--space-1);
	}
	audio {
		width: 100%;
		max-width: 22rem;
	}
	.small {
		font-size: var(--text-sm);
	}
</style>
