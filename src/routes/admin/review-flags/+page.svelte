<script lang="ts">
	import { resolve } from '$app/paths';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import X from '@lucide/svelte/icons/x';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import WorkerPicker from '$lib/components/WorkerPicker.svelte';
	import { formatDate, formatTime } from '$lib/date';
	import { shiftTypeLabel } from '$lib/shiftLabels';

	let { data, form } = $props();

	const REASONS: Record<string, string> = {
		incorrect_match: 'Incorrect person match',
		missing_person: 'Person missing from attendance',
		wrong_session: 'Wrong session or date',
		poor_photo: 'Photo quality issue',
		other: 'Other issue'
	};
	const RESOLUTIONS: Record<string, string> = {
		moved: 'Face moved to',
		new_worker: 'Face moved to new worker',
		marked_present: 'Marked present',
		dismissed: 'Dismissed'
	};
</script>

<svelte:head><title>Flagged errors | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div>
			<p class="eyebrow">Review queue</p>
			<h1>Flagged errors</h1>
			<p>Every "Flag error" raised on attendance evidence. Fix it here, or dismiss it.</p>
		</div>
		<StatusBadge tone={data.flags.length ? 'attention' : 'success'}
			>{data.flags.length} open</StatusBadge
		>
	</header>

	{#if form?.message}
		<p class:alert--error={!form.success} class="alert" role="status">{form.message}</p>
	{/if}

	{#if data.flags.length}
		<div class="flag-list" data-testid="review-flags">
			{#each data.flags as flag (flag.id)}
				<article class="flag-card" data-testid="review-flag">
					<div class="flag-evidence">
						{#if flag.person_id}
							{#if flag.face_crop_url}
								<img src={flag.face_crop_url} alt={`Flagged face of ${flag.worker}`} />
							{:else}
								<span class="flag-noface">No face picture</span>
							{/if}
						{/if}
						{#if flag.has_photo}
							<a
								class="button button--secondary"
								href={resolve(`/api/attendance/photo/${flag.session_id}`)}
								target="_blank"
								rel="noopener"><ExternalLink size={16} /> Whole photo</a
							>
						{/if}
					</div>
					<div class="flag-body">
						<div>
							<p class="eyebrow">
								{shiftTypeLabel(flag.session_type)} · {formatDate(flag.session_date)}
							</p>
							<h2>{REASONS[flag.reason] ?? flag.reason}</h2>
							<p>
								{flag.pump_code} · {flag.plant_name}
								{#if flag.worker}· counted as <strong>{flag.worker}</strong>{/if}
							</p>
							{#if flag.note}<p class="flag-note">“{flag.note}”</p>{/if}
							<p class="flag-meta">
								Flagged by {flag.flagged_by}, {formatDate(flag.created_at)}, {formatTime(
									flag.created_at
								)}
							</p>
						</div>

						{#if flag.person_id}
							<form method="POST" action="?/moveFace" class="flag-fix">
								<input type="hidden" name="id" value={flag.id} />
								<p class="flag-fix__title">Whose face is this?</p>
								<WorkerPicker workers={flag.candidates} />
								<button class="button button--primary" type="submit">Move face</button>
							</form>
						{:else}
							<form method="POST" action="?/markPresent" class="flag-fix">
								<input type="hidden" name="id" value={flag.id} />
								<p class="flag-fix__title">Who is missing from this photo?</p>
								<WorkerPicker workers={flag.candidates} newLabel="Not listed" nameRequired />
								<button class="button button--primary" type="submit">Mark present</button>
							</form>
						{/if}
						<form method="POST" action="?/dismiss">
							<input type="hidden" name="id" value={flag.id} />
							<button class="button button--secondary" type="submit"
								><X size={16} /> Dismiss, nothing wrong</button
							>
						</form>
					</div>
				</article>
			{/each}
		</div>
	{:else}
		<EmptyState
			title="No open flagged errors"
			description="Errors flagged on a worker's photo or a shift photo appear here."
		/>
	{/if}

	{#if data.closed.length}
		<section class="section">
			<div class="section-header"><h2>Recently closed</h2></div>
			<ul class="closed-list">
				{#each data.closed as flag (flag.id)}
					<li>
						<strong
							>{RESOLUTIONS[flag.resolution] ?? 'Closed'}
							{#if flag.worker && flag.resolution !== 'dismissed'}{flag.worker}{/if}</strong
						>
						<span>
							{REASONS[flag.reason] ?? flag.reason} · {flag.pump_code} · {shiftTypeLabel(
								flag.session_type
							)}
							{formatDate(flag.session_date)}
							{#if flag.resolved_at}
								· closed {formatDate(flag.resolved_at)}, {formatTime(flag.resolved_at)}
							{/if}
							{#if flag.resolved_by}by {flag.resolved_by}{/if}
						</span>
					</li>
				{/each}
			</ul>
		</section>
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
	.flag-list {
		display: grid;
		gap: var(--space-4);
	}
	.flag-card {
		display: grid;
		grid-template-columns: minmax(0, 12rem) minmax(0, 1fr);
		gap: var(--space-4);
		padding: var(--space-4);
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.flag-evidence {
		display: grid;
		align-content: start;
		gap: var(--space-2);
	}
	.flag-evidence img,
	.flag-noface {
		width: 100%;
		aspect-ratio: 1;
		object-fit: cover;
		border-radius: var(--radius-md);
		background: var(--surface-muted);
	}
	.flag-noface {
		display: grid;
		place-items: center;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.flag-body {
		display: grid;
		gap: var(--space-3);
		min-width: 0;
	}
	.flag-body h2 {
		margin: 0 0 var(--space-1);
		font-size: var(--text-lg);
	}
	.flag-body p {
		margin: 0 0 var(--space-1);
	}
	.flag-note {
		font-style: italic;
	}
	.flag-meta {
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.flag-fix {
		display: grid;
		gap: var(--space-2);
		padding-top: var(--space-3);
		border-top: 1px solid var(--brand-mist);
	}
	.flag-fix__title {
		font-weight: 700;
	}
	.flag-fix .button {
		justify-self: start;
	}
	.closed-list {
		display: grid;
		gap: var(--space-2);
		max-height: 24rem;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		list-style: none;
	}
	.closed-list li {
		display: grid;
		gap: 2px;
		padding: var(--space-2) var(--space-3);
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.closed-list span {
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	@media (max-width: 40rem) {
		.flag-card {
			grid-template-columns: 1fr;
		}
		.flag-evidence {
			grid-template-columns: 8rem 1fr;
			align-items: start;
		}
	}
</style>
