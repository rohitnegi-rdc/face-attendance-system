<script lang="ts">
	// One waiting regularisation request with its evidence and Approve / Reject (a reason is
	// required to reject). Used on Missed days (admin and business manager) and on the admin
	// Overview for requests waiting over 2 days. `action` is the decide form action: '?/decide' on
	// the Missed days page, the Missed days page's action from elsewhere.
	import { enhance } from '$app/forms';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import RegularisationEvidence from '$lib/components/RegularisationEvidence.svelte';
	import { formatHumanDay } from '$lib/date';
	import { REJECT_TEXT } from '$lib/regularisationLabels';
	import type { RequestRow } from '$lib/server/regularisation';
	import type { SubmitFunction } from '@sveltejs/kit';

	let {
		r,
		role,
		action = '?/decide',
		showWaiting = false
	}: {
		r: RequestRow;
		role: 'admin' | 'plant-manager';
		action?: string;
		// Say how long it has waited and whose decision it was (admin Overview).
		showWaiting?: boolean;
	} = $props();

	let rejecting = $state(false);
	let message = $state<{ ok: boolean; text: string } | null>(null);

	// Keeps the typed reject note on a failure; the list reloads, so a decided card disappears.
	const decide: SubmitFunction = () => {
		message = null;
		return async ({ result, update }) => {
			if (result.type === 'success' || result.type === 'failure') {
				const text = String(result.data?.message ?? '');
				if (text) message = { ok: result.type === 'success', text };
			}
			await update({ reset: false });
		};
	};
</script>

<li
	class="card surface surface--padded"
	class:card--late={showWaiting}
	data-testid="reg-decide"
	data-pump={r.pumpCode}
>
	<div class="card__head">
		<strong class="day">{formatHumanDay(r.day)}</strong>
		<span>{r.pumpCode} · {r.plantName}, {r.areaName}</span>
	</div>
	{#if showWaiting}
		<p class="waiting" data-testid="reg-waiting">
			Waiting {r.waitingDays}
			{r.waitingDays === 1 ? 'day' : 'days'}: {r.approverName
				? `${r.approverName} (business manager) has not decided.`
				: 'this plant has no business manager.'} Any admin can decide it here.
		</p>
	{/if}
	<RegularisationEvidence {r} {role} />
	{#if message}
		<p class="alert" class:alert--error={!message.ok} role="status">{message.text}</p>
	{/if}
	<div class="actions">
		<form method="POST" {action} use:enhance={decide}>
			<input type="hidden" name="id" value={r.id} />
			<input type="hidden" name="decision" value="approve" />
			<button class="button button--primary" type="submit" data-testid="reg-approve"
				><Check size={17} /> Approve</button
			>
		</form>
		{#if rejecting}
			<form method="POST" {action} class="reject" use:enhance={decide}>
				<input type="hidden" name="id" value={r.id} />
				<input type="hidden" name="decision" value="reject" />
				<label class="field"
					><span>Why reject?</span>
					<select name="reject_reason" required data-testid="reg-reject-reason">
						{#each Object.entries(REJECT_TEXT) as [key, text] (key)}
							<option value={key}>{text}</option>
						{/each}
					</select></label
				>
				<label class="field"
					><span>Note (needed for Other)</span><input name="note" maxlength="400" /></label
				>
				<button class="button button--danger" type="submit" data-testid="reg-reject"
					><X size={17} /> Reject</button
				>
			</form>
		{:else}
			<button
				class="button button--secondary"
				type="button"
				data-testid="reg-reject-open"
				onclick={() => (rejecting = true)}>Reject…</button
			>
		{/if}
	</div>
</li>

<style>
	.card {
		display: grid;
		gap: var(--space-2);
		min-width: 0;
	}
	/* Overdue: the same red edge as fraud, it needs an admin now. */
	.card--late {
		box-shadow: inset 4px 0 0 var(--alert);
	}
	.card__head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-1) var(--space-3);
	}
	.day {
		font-size: var(--text-lg);
	}
	.waiting {
		margin: 0;
		color: var(--alert);
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.actions,
	.reject {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: flex-end;
	}
</style>
