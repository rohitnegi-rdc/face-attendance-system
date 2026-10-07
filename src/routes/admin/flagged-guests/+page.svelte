<script lang="ts">
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import X from '@lucide/svelte/icons/x';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/date';

	let { data } = $props();
</script>

<svelte:head><title>Guest review | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div>
			<p class="eyebrow">Review queue</p>
			<h1>Guest review</h1>
			<p>Resolve faces that could not be confidently matched.</p>
		</div>
		<StatusBadge tone="attention">{data.guests.length} pending</StatusBadge>
	</header>

	{#if data.guests.length}
		<div class="guest-grid" data-testid="flagged-guests-grid">
			{#each data.guests as guest}
				<article class="guest-card">
					<div class="guest-image">
						{#if guest.face_crop_url}
							<img
								src={guest.face_crop_url}
								alt={`Unmatched face from ${guest.pump_code}`}
								loading="lazy"
							/>
						{:else}
							<span>No crop available</span>
						{/if}
					</div>
					<div class="guest-content">
						<div>
							<p class="eyebrow">{guest.session_type} session</p>
							<h2>{guest.pump_code}</h2>
							<p>{guest.plant_name} · {guest.area_name}</p>
						</div>
						<dl>
							<div>
								<dt>Session date</dt>
								<dd>{formatDate(guest.session_date)}</dd>
							</div>
							<div>
								<dt>Detected</dt>
								<dd>{formatDate(guest.created_at)}</dd>
							</div>
						</dl>
						<p class="fixed-note">A new person will remain assigned to {guest.pump_code}.</p>
						<div class="guest-actions">
							<form method="POST" action="?/promote">
								<input type="hidden" name="id" value={guest.id} />
								<button class="button button--primary" type="submit"
									><UserPlus size={17} /> Create person</button
								>
							</form>
							<form method="POST" action="?/dismiss">
								<input type="hidden" name="id" value={guest.id} />
								<button class="button button--secondary" type="submit"
									><X size={17} /> Dismiss guest</button
								>
							</form>
						</div>
					</div>
				</article>
			{/each}
		</div>
	{:else}
		<EmptyState
			title="Guest queue is clear"
			description="New unmatched faces will appear here with their source session."
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
	.guest-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 25rem), 1fr));
		gap: var(--space-4);
	}
	.guest-card {
		display: grid;
		grid-template-columns: 9rem 1fr;
		overflow: hidden;
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.guest-image {
		min-height: 14rem;
		background: var(--surface-muted);
	}
	.guest-image img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.guest-image span {
		display: grid;
		height: 100%;
		place-items: center;
		padding: var(--space-3);
		color: var(--ink-muted);
		text-align: center;
	}
	.guest-content {
		display: grid;
		align-content: start;
		gap: var(--space-3);
		padding: var(--space-4);
	}
	.guest-content h2 {
		margin: 0;
		font-size: var(--text-lg);
	}
	.guest-content p {
		margin: var(--space-1) 0 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	dl {
		display: grid;
		gap: var(--space-2);
		margin: 0;
	}
	dl div {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
	}
	dt {
		color: var(--ink-muted);
	}
	dd {
		margin: 0;
		text-align: right;
	}
	.fixed-note {
		padding: var(--space-3);
		background: var(--surface-subtle);
	}
	.guest-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	@media (max-width: 30rem) {
		.guest-card {
			grid-template-columns: 1fr;
		}
		.guest-image {
			min-height: 12rem;
			max-height: 16rem;
		}
		.guest-actions,
		.guest-actions form,
		.guest-actions .button {
			width: 100%;
		}
	}
</style>
