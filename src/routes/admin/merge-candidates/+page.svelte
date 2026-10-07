<script lang="ts">
	import GitMerge from '@lucide/svelte/icons/git-merge';
	import X from '@lucide/svelte/icons/x';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';

	let { data, form } = $props();
</script>

<svelte:head><title>Merge review | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div>
			<p class="eyebrow">Review queue</p>
			<h1>Merge review</h1>
			<p>Compare likely duplicate people from the same pump.</p>
		</div>
		<StatusBadge tone="attention">{data.candidates.length} pending</StatusBadge>
	</header>

	{#if form?.message}
		<p class:alert--error={!form.success} class="alert" role="status">{form.message}</p>
	{/if}

	{#if data.candidates.length}
		<div class="review-list" data-testid="merge-candidates-list">
			{#each data.candidates as candidate}
				<article class="review-item">
					<div class="merge-heading">
						<div>
							<p class="eyebrow">{candidate.pump_code}</p>
							<h2>Possible duplicate</h2>
						</div>
						<StatusBadge tone="neutral"
							>{(Number(candidate.similarity) * 100).toFixed(1)}% similar</StatusBadge
						>
					</div>

					<div class="comparison">
						<div class="person-evidence">
							{#if candidate.crop_a}<img src={candidate.crop_a} alt="" loading="lazy" />{:else}<span
									>No crop</span
								>{/if}
							<strong>{personDisplayLabel(candidate.pump_code, candidate.display_seq_a)}</strong>
							<small>First seen {formatDate(candidate.first_seen_a)}</small>
							<small>Last seen {formatDate(candidate.last_seen_a)}</small>
							<small>{candidate.days_a} attendance days</small>
						</div>
						<div class="comparison-mark" aria-hidden="true"><GitMerge size={23} /></div>
						<div class="person-evidence">
							{#if candidate.crop_b}<img src={candidate.crop_b} alt="" loading="lazy" />{:else}<span
									>No crop</span
								>{/if}
							<strong>{personDisplayLabel(candidate.pump_code, candidate.display_seq_b)}</strong>
							<small>First seen {formatDate(candidate.first_seen_b)}</small>
							<small>Last seen {formatDate(candidate.last_seen_b)}</small>
							<small>{candidate.days_b} attendance days</small>
						</div>
					</div>

					<div class="merge-note">
						Merging keeps {personDisplayLabel(candidate.pump_code, candidate.display_seq_a)} as the primary
						identity and combines attendance history.
					</div>
					<div class="review-actions">
						<form method="POST" action="?/confirm">
							<input type="hidden" name="kept" value={candidate.person_a} />
							<input type="hidden" name="merged" value={candidate.person_b} />
							<input type="hidden" name="similarity" value={candidate.similarity} />
							<button class="button button--primary" type="submit"
								><GitMerge size={17} /> Merge people</button
							>
						</form>
						<form method="POST" action="?/dismiss">
							<input type="hidden" name="person_a" value={candidate.person_a} />
							<input type="hidden" name="person_b" value={candidate.person_b} />
							<input type="hidden" name="similarity" value={candidate.similarity} />
							<button class="button button--secondary" type="submit"
								><X size={17} /> Dismiss suggestion</button
							>
						</form>
					</div>
				</article>
			{/each}
		</div>
	{:else}
		<EmptyState
			title="No merge suggestions"
			description="Potential same-pump duplicate identities will appear here."
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
	.merge-heading,
	.review-actions {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-4);
	}
	.merge-heading h2 {
		margin: 0;
		font-size: var(--text-lg);
	}
	.comparison {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		gap: var(--space-4);
		align-items: center;
		margin: var(--space-4) 0;
	}
	.person-evidence {
		display: grid;
		justify-items: center;
		gap: var(--space-1);
		min-width: 0;
		padding: var(--space-3) var(--space-4);
		text-align: center;
		background: var(--surface-subtle);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.person-evidence img,
	.person-evidence > span {
		width: 6rem;
		height: 6rem;
		margin-bottom: var(--space-2);
		object-fit: cover;
		border-radius: var(--radius-md);
	}
	.person-evidence > span {
		display: grid;
		place-items: center;
		color: var(--ink-muted);
		background: var(--surface-muted);
	}
	.person-evidence small {
		color: var(--ink-muted);
	}
	.comparison-mark {
		display: grid;
		width: 2.75rem;
		height: 2.75rem;
		place-items: center;
		color: var(--brand-teal);
		background: var(--primary-tint);
		border-radius: 50%;
	}
	.merge-note {
		padding: var(--space-3);
		color: var(--ink-muted);
		background: var(--surface-subtle);
	}
	.review-actions {
		justify-content: flex-end;
		margin-top: var(--space-3);
	}
	@media (max-width: 36rem) {
		.comparison {
			grid-template-columns: 1fr;
		}
		.comparison-mark {
			margin: calc(var(--space-2) * -1) auto;
			transform: rotate(90deg);
		}
		.review-actions,
		.review-actions form,
		.review-actions .button {
			width: 100%;
		}
		.review-actions {
			flex-direction: column;
		}
	}
</style>
