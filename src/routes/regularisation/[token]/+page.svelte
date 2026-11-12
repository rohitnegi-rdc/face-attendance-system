<script lang="ts">
	// The email's Approve / Reject page (load and actions in +page.server.ts): the request in full,
	// then one button. Nothing is decided until it is pressed. Phone first.
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import AuthPanel from '$lib/components/AuthPanel.svelte';
	import { formatHumanDay } from '$lib/date';
	import { REASON_TEXT, REJECT_TEXT, STATUS_TEXT } from '$lib/regularisationLabels';

	let { data, form } = $props();
	let picked = $state<'approve' | 'reject' | null>(null);
	const choice = $derived(
		picked ?? (data.state !== 'invalid' && data.chosen === 'reject' ? 'reject' : 'approve')
	);
	let sending = $state(false);
	const r = $derived(data.state === 'invalid' ? null : data.request);
	const voiceUrl = $derived(`${page.url.pathname.replace(/\/$/, '')}/voice`);
	const asker = $derived(
		!r
			? ''
			: r.requestedByRole === 'pump'
				? 'The pump operator'
				: `${r.requestedByName} (${r.requestedByRole === 'plant_manager' ? 'plant manager' : 'admin'})`
	);
	const ordinal = (n: number) =>
		n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
	const submit = () => {
		sending = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			sending = false;
		};
	};
</script>

<svelte:head><title>Missed day | Face Attendance</title></svelte:head>

<AuthPanel labelledby="reg-title">
	{#if !r}
		<div class="auth-heading" data-testid="reg-link-invalid">
			<h1 id="reg-title">This link does not work</h1>
			<p>It may be cut short in the email. Open the request from Missed days in the app instead.</p>
		</div>
	{:else}
		<div class="auth-heading">
			<p class="eyebrow">Missed day</p>
			<h1 id="reg-title">{r.pumpCode} · {formatHumanDay(r.day)}</h1>
		</div>

		<dl class="facts" data-testid="reg-facts">
			<div>
				<dt>Plant</dt>
				<dd>{r.plantName} ({r.areaName})</dd>
			</div>
			<div>
				<dt>Plant manager</dt>
				<dd>{r.plantManagerName ?? 'None on file'}</dd>
			</div>
			<div>
				<dt>Reason</dt>
				<dd>
					<span aria-hidden="true">{REASON_TEXT[r.reason]?.icon}</span>
					{REASON_TEXT[r.reason]?.en ?? r.reason}{#if r.note}: {r.note}{/if}
				</dd>
			</div>
			{#if r.hasVoice}
				<div>
					<dt>Voice note</dt>
					<dd>
						<audio controls preload="none" src={voiceUrl}
							><a href={voiceUrl}>Play the voice note</a></audio
						>
					</dd>
				</div>
			{/if}
			<div>
				<dt>Workers</dt>
				<dd>{r.workers.length}: {r.workers.join(', ')}</dd>
			</div>
			<div>
				<dt>Asked by</dt>
				<dd>{asker}, {r.requestedAt}</dd>
			</div>
			<div>
				<dt>This month</dt>
				<dd>{ordinal(r.monthCount)} missed day asked for at this pump</dd>
			</div>
			<div>
				<dt>Last photo before</dt>
				<dd>{r.lastPhotoDay ? formatHumanDay(r.lastPhotoDay) : 'None'}</dd>
			</div>
		</dl>

		{#if form?.done}
			<p class="alert alert--success" role="status" data-testid="reg-link-done">
				{form.done === 'approved'
					? 'Approved. The day now counts as Regularised.'
					: 'Rejected. The operator will see your reason.'}
			</p>
		{:else if data.state === 'not_yours'}
			<p class="alert alert--error" role="status" data-testid="reg-link-not-yours">
				This link is no longer yours to decide: the plant has another business manager now. An admin
				can decide it in the app.
			</p>
		{:else if r.status !== 'pending'}
			<p class="alert" role="status" data-testid="reg-link-settled">
				{STATUS_TEXT[r.status]}{r.decidedByName ? ` by ${r.decidedByName}` : ''}{r.decidedAt
					? ` on ${r.decidedAt}`
					: ''}{r.decisionReason ? `: ${r.decisionReason}` : ''}. Nothing more to do.
			</p>
		{:else}
			{#if form?.message}<p class="alert alert--error" role="status">{form.message}</p>{/if}
			<div class="choice" role="tablist" aria-label="Decision">
				<button
					type="button"
					role="tab"
					aria-selected={choice === 'approve'}
					class="button"
					class:button--primary={choice === 'approve'}
					class:button--secondary={choice !== 'approve'}
					onclick={() => (picked = 'approve')}>Approve</button
				>
				<button
					type="button"
					role="tab"
					aria-selected={choice === 'reject'}
					class="button"
					class:button--danger={choice === 'reject'}
					class:button--secondary={choice !== 'reject'}
					onclick={() => (picked = 'reject')}>Reject</button
				>
			</div>
			{#if choice === 'approve'}
				<form method="POST" action="?/approve" use:enhance={submit} class="decide">
					<p>
						{r.workers.length}
						{r.workers.length === 1 ? 'worker' : 'workers'} will be counted for {formatHumanDay(
							r.day
						)}, shown as Regularised.
					</p>
					<button
						class="button button--primary wide"
						type="submit"
						disabled={sending}
						data-testid="reg-link-approve">Approve this day</button
					>
				</form>
			{:else}
				<form method="POST" action="?/reject" use:enhance={submit} class="decide">
					<label class="field"
						><span>Why reject?</span>
						<select name="reject_reason" required data-testid="reg-link-reason">
							{#each Object.entries(REJECT_TEXT) as [key, text] (key)}
								<option value={key}>{text}</option>
							{/each}
						</select></label
					>
					<label class="field"
						><span>Note (needed for Other)</span><input name="note" maxlength="400" /></label
					>
					<button
						class="button button--danger wide"
						type="submit"
						disabled={sending}
						data-testid="reg-link-reject">Reject this day</button
					>
				</form>
			{/if}
			<p class="muted small">Deciding as {data.deciderName}.</p>
		{/if}
	{/if}
</AuthPanel>

<style>
	.facts {
		display: grid;
		gap: var(--space-2);
		margin: var(--space-4) 0;
	}
	.facts div {
		display: grid;
		grid-template-columns: 8.5rem 1fr;
		gap: var(--space-2);
	}
	.facts dt {
		color: var(--ink-muted);
	}
	.facts dd {
		margin: 0;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	audio {
		width: 100%;
	}
	.choice {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-2);
		margin-bottom: var(--space-3);
	}
	.decide {
		display: grid;
		gap: var(--space-3);
	}
	.wide {
		width: 100%;
		justify-content: center;
	}
	.small {
		font-size: var(--text-sm);
	}
	@media (max-width: 24rem) {
		.facts div {
			grid-template-columns: 1fr;
			gap: 0;
		}
	}
</style>
