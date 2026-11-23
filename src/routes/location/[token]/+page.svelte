<script lang="ts">
	// The location approval email's Approve / Reject page (load and actions in +page.server.ts):
	// the shift start in a few lines, its photo, then one button. Nothing is decided until it is
	// pressed. Phone first: plant managers open it from the email on their phone.
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import AuthPanel from '$lib/components/AuthPanel.svelte';
	import { mapUrl } from '$lib/maps';

	let { data, form } = $props();
	let picked = $state<'approve' | 'reject' | null>(null);
	const choice = $derived(
		picked ?? (data.state !== 'invalid' && data.chosen === 'reject' ? 'reject' : 'approve')
	);
	let sending = $state(false);
	const s = $derived(data.state === 'invalid' ? null : data.shift);
	const photoUrl = $derived(`${page.url.pathname.replace(/\/$/, '')}/photo`);
	const submit = () => {
		sending = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			sending = false;
		};
	};
</script>

<svelte:head><title>Shift start location | Face Attendance</title></svelte:head>

<AuthPanel labelledby="loc-title">
	{#if !s}
		<div class="auth-heading" data-testid="loc-link-invalid">
			<h1 id="loc-title">This link does not work</h1>
			<p>It may be cut short in the email. Open Approvals in the app instead.</p>
		</div>
	{:else}
		<div class="auth-heading">
			<p class="eyebrow">Shift start location</p>
			<h1 id="loc-title">Pump {s.pumpCode}</h1>
			<p>Shift start photo sent at <strong>{s.sentAt}</strong></p>
		</div>

		<p class="why" data-testid="loc-link-why">
			<strong>Why you are asked:</strong>
			{s.waited ? `${s.problem} ${s.waited}` : s.problem}
		</p>

		<dl class="facts">
			<div>
				<dt>Plant</dt>
				<dd>{s.plantName} ({s.areaName})</dd>
			</div>
			<div>
				<dt>In the photo</dt>
				<dd>{s.faces} {s.faces === 1 ? 'person' : 'people'}</dd>
			</div>
			{#if s.phone || s.pump}
				<div>
					<dt>On the map</dt>
					<!-- eslint-disable svelte/no-navigation-without-resolve -- Google Maps, outside the app -->
					<dd class="maps">
						{#if s.phone}<a href={mapUrl(s.phone.lat, s.phone.lng)} target="_blank" rel="noreferrer"
								>Where the photo was taken</a
							>{/if}
						{#if s.pump}<a href={mapUrl(s.pump.lat, s.pump.lng)} target="_blank" rel="noreferrer"
								>Where the pump was</a
							>{/if}
					</dd>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				</div>
			{/if}
		</dl>

		{#if s.hasPhoto && data.state === 'open'}
			<img class="photo" src={photoUrl} alt="Shift start photo from {s.pumpCode}" />
		{/if}

		{#if form?.done}
			<p class="alert alert--success" role="status" data-testid="loc-link-done">
				{form.done === 'approved'
					? 'Approved. This shift start now counts.'
					: 'Rejected. This shift start does not count. The admin sees your reason.'}
			</p>
		{:else if data.state === 'not_yours'}
			<p class="alert alert--error" role="status" data-testid="loc-link-not-yours">
				This link is no longer yours to decide: you no longer look after this pump. Its plant
				manager or an admin can decide it in the app.
			</p>
		{:else if s.status !== 'pending'}
			<p class="alert" role="status" data-testid="loc-link-settled">
				{#if s.autoCleared}
					Already approved by itself: {s.note}
				{:else}
					{s.status === 'approved' ? 'Approved' : 'Rejected'}{s.decidedBy
						? ` by ${s.decidedBy}`
						: ''}{s.decidedAt ? ` at ${s.decidedAt}` : ''}{s.note ? `: ${s.note}` : ''}.
				{/if}
				Nothing more to do.
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
					<p>The crew was at the pump. This shift start will count.</p>
					<label class="field"
						><span>Note (optional)</span><input
							name="note"
							maxlength="400"
							placeholder="For example: I called the operator"
						/></label
					>
					<button
						class="button button--primary wide"
						type="submit"
						disabled={sending}
						data-testid="loc-link-approve">Approve this shift start</button
					>
				</form>
			{:else}
				<form method="POST" action="?/reject" use:enhance={submit} class="decide">
					<p>The crew was not at the pump. This shift start will not count.</p>
					<label class="field"
						><span>Why reject? (needed)</span><textarea
							name="note"
							required
							maxlength="400"
							rows="3"
							data-testid="loc-link-reason"></textarea></label
					>
					<button
						class="button button--danger wide"
						type="submit"
						disabled={sending}
						data-testid="loc-link-reject">Reject this shift start</button
					>
				</form>
			{/if}
			<p class="muted small">Deciding as {data.deciderName}.</p>
		{/if}
	{/if}
</AuthPanel>

<style>
	.why {
		margin: var(--space-3) 0;
		padding: var(--space-3);
		background: #fff4e5;
		color: #1b1f23;
		border-left: 4px solid #e07b00;
		border-radius: 4px;
	}
	.facts {
		display: grid;
		gap: var(--space-2);
		margin: var(--space-3) 0;
	}
	.facts div {
		display: grid;
		grid-template-columns: 7.5rem 1fr;
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
	.maps {
		display: grid;
		gap: var(--space-1);
	}
	.photo {
		display: block;
		width: 100%;
		max-height: 20rem;
		object-fit: contain;
		margin-bottom: var(--space-3);
		border-radius: 6px;
		background: var(--surface-muted, #f1f3f5);
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
	.decide p {
		margin: 0;
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
