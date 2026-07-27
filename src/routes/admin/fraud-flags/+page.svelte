<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';

	let { data } = $props();
</script>

<svelte:head><title>Fraud review | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div>
			<p class="eyebrow">Review queue</p>
			<h1>Fraud flags</h1>
			<p>Review attendance overlaps found across different pumps.</p>
		</div>
		<StatusBadge tone="attention"
			>{data.flags.filter((flag: any) => !flag.reviewed).length} pending</StatusBadge
		>
	</header>

	{#if data.flags.length}
		<div class="review-list" data-testid="fraud-flags-table">
			{#each data.flags as flag}
				<article class="review-item">
					<div class="review-item__header">
						<div>
							<h2>{personDisplayLabel(flag.matched_at_pump, flag.display_seq)}</h2>
							<p>{formatDate(flag.created_at)}</p>
						</div>
						<StatusBadge tone={flag.reviewed ? 'neutral' : 'attention'}>
							{flag.reviewed ? 'Reviewed' : 'Needs review'}
						</StatusBadge>
					</div>

					<div class="fraud-evidence">
						<div class="face-evidence">
							{#if flag.source_photo_crop_url}
								<img
									src={flag.source_photo_crop_url}
									alt={`Face crop for ${personDisplayLabel(flag.matched_at_pump, flag.display_seq)}`}
									loading="lazy"
								/>
							{:else}
								<span><ShieldAlert size={28} /></span>
							{/if}
							<div>
								<strong>{(Number(flag.similarity_score) * 100).toFixed(1)}% similarity</strong>
								<small>Cross-pump match score</small>
							</div>
						</div>
						<div class="location-comparison">
							<div>
								<span>Flagged attendance</span>
								<strong>{flag.flagged_at_pump}</strong>
								<small>{flag.flagged_at_plant} · {formatDate(flag.flagged_submitted_at)}</small>
								<a href={`/api/attendance/photo/${flag.session_id}`} target="_blank"
									>View group photo</a
								>
							</div>
							<div>
								<span>Earlier match</span>
								<strong>{flag.matched_at_pump}</strong>
								<small>{flag.matched_at_plant} · {formatDate(flag.matched_submitted_at)}</small>
								<a href={`/api/attendance/photo/${flag.matched_session_id}`} target="_blank"
									>View group photo</a
								>
							</div>
						</div>
					</div>

					{#if !flag.reviewed}
						<div class="review-actions">
							<p>Marking reviewed records that this evidence has been checked.</p>
							<form method="POST" action="?/review">
								<input type="hidden" name="id" value={flag.id} />
								<button class="button button--primary" type="submit"
									><Check size={17} /> Mark reviewed</button
								>
							</form>
						</div>
					{/if}
				</article>
			{/each}
		</div>
	{:else}
		<EmptyState
			title="No fraud flags"
			description="Cross-pump attendance overlaps will appear here for review."
		/>
	{/if}
</div>

<style>
	.eyebrow {
		margin: 0 0 var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
	}
	.review-list {
		display: grid;
		gap: var(--space-4);
	}
	.review-item__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-4);
	}
	.review-item__header h2 {
		margin: 0;
		font-size: var(--text-lg);
	}
	.review-item__header p {
		margin: var(--space-1) 0 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.fraud-evidence {
		display: grid;
		grid-template-columns: minmax(13rem, 0.7fr) minmax(0, 1.3fr);
		gap: var(--space-5);
		margin-top: var(--space-5);
	}
	.face-evidence {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
	.face-evidence img,
	.face-evidence > span {
		width: 5rem;
		height: 5rem;
		object-fit: cover;
		border-radius: var(--radius-md);
	}
	.face-evidence > span {
		display: grid;
		place-items: center;
		color: var(--ink-muted);
		background: var(--surface-muted);
	}
	.face-evidence div {
		display: grid;
		gap: var(--space-1);
	}
	.face-evidence small,
	.location-comparison span,
	.location-comparison small {
		color: var(--ink-muted);
	}
	.location-comparison {
		display: grid;
		grid-template-columns: 1fr 1fr;
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.location-comparison > div {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-4);
	}
	.location-comparison > div + div {
		border-left: 1px solid var(--brand-mist);
	}
	.location-comparison a {
		margin-top: var(--space-2);
		font-size: var(--text-sm);
		font-weight: 700;
	}
	.review-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		margin-top: var(--space-5);
		padding-top: var(--space-4);
		border-top: 1px solid var(--brand-mist);
	}
	.review-actions p {
		margin: 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	@media (max-width: 48rem) {
		.fraud-evidence {
			grid-template-columns: 1fr;
		}
		.location-comparison {
			grid-template-columns: 1fr;
		}
		.location-comparison > div + div {
			border-top: 1px solid var(--brand-mist);
			border-left: 0;
		}
		.review-actions {
			align-items: stretch;
			flex-direction: column;
		}
		.review-actions .button {
			width: 100%;
		}
	}
</style>
