<script lang="ts">
	// Missed days (regularisation), one body for the admin and plant-manager pages. Three blocks,
	// phone first: requests to decide (evidence inline: reason, voice note, workers), the calendar of
	// one pump to apply for a date (the form opens under it), and every request with its outcome.
	import { enhance } from '$app/forms';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import RegularisationCalendar from '$lib/components/RegularisationCalendar.svelte';
	import RegularisationDecideCard from '$lib/components/RegularisationDecideCard.svelte';
	import RegularisationEvidence from '$lib/components/RegularisationEvidence.svelte';
	import { formatHumanDay } from '$lib/date';
	import { applyOnSelect } from '$lib/liveSearch';
	import { HALF_TEXT, REASON_TEXT, STATUS_TEXT } from '$lib/regularisationLabels';
	import type { Crew, RequestablePump, RequestRow } from '$lib/server/regularisation';
	import type { CalendarDay, CalendarMonth } from '$lib/server/regularisationDays';

	let {
		role,
		data,
		form
	}: {
		role: 'admin' | 'plant-manager';
		data: {
			requests: RequestRow[];
			pumps: RequestablePump[];
			pump: RequestablePump | null;
			calendar: CalendarMonth | null;
			selected: CalendarDay | null;
			crew: Crew | null;
		};
		form: { formKind?: string; id?: string; success?: boolean; message?: string } | null;
	} = $props();

	const toDecide = $derived(data.requests.filter((r) => r.canDecide));
	const others = $derived(data.requests.filter((r) => !r.canDecide));
	const monthHref = (month: string) => `?pump=${data.pump?.id}&month=${month}`;
	const dayHref = (day: string) => `?pump=${data.pump?.id}&month=${day.slice(0, 7)}&day=${day}`;
	const keep =
		() =>
		async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) =>
			update({ reset: false });
</script>

{#snippet rowMessage(r: RequestRow)}
	{#if form?.formKind === 'row' && form?.id === r.id && form?.message}
		<p class="alert" class:alert--error={!form.success} role="status">{form.message}</p>
	{/if}
{/snippet}

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Regularisation</p>
			<h1>Missed days</h1>
			<p>
				A past day with no photo, or where a worker has only a start or only an end, can be counted
				once it is approved. The operator applies on the pump screen{role === 'plant-manager'
					? ', or you apply for them below when their phone is broken or lost'
					: ''}. The plant's business manager approves; an admin can too. An approved day shows as
				Regularised everywhere.
			</p>
		</div>
	</header>

	{#if toDecide.length || role === 'admin'}
		<section class="section" aria-labelledby="decide-heading">
			<h2 id="decide-heading">To decide <span class="count">{toDecide.length}</span></h2>
			{#if toDecide.length}
				<ul class="cards">
					{#each toDecide as r (r.id)}
						<RegularisationDecideCard {r} {role} />
					{/each}
				</ul>
			{:else}
				<EmptyState
					title="Nothing to decide"
					description="New requests appear here and are emailed to the approver."
				/>
			{/if}
		</section>
	{/if}

	{#if data.pump && data.calendar}
		<section class="section" aria-labelledby="missing-heading" id="ask">
			<h2 id="missing-heading">Apply for a date</h2>
			<p class="muted">
				{role === 'admin'
					? 'Choose a pump and a red day. Regularising here counts the day at once, recorded under your name.'
					: 'Choose a pump and a red day. Apply only when the operator cannot: the request still goes to the business manager.'}
			</p>
			<form method="GET" class="picker" onchange={applyOnSelect}>
				<label class="field"
					><span>Pump</span>
					<select name="pump" value={data.pump.id} data-testid="reg-pump">
						{#each data.pumps as p (p.id)}
							<option value={p.id}
								>{p.code} · {p.plantName}{p.missed ? ` · ${p.missed} missed` : ''}</option
							>
						{/each}
					</select></label
				>
			</form>

			<div class="surface surface--padded apply">
				<RegularisationCalendar
					calendar={data.calendar}
					selected={data.selected?.day ?? null}
					{dayHref}
					{monthHref}
				/>

				{#if form?.formKind === 'request' && form?.message}
					<p
						class="alert"
						class:alert--error={!form.success}
						role="status"
						data-testid="reg-request-message"
					>
						{form.message}
					</p>
				{/if}

				{#if data.selected && data.crew}
					{@const half = data.crew.kind === 'partial'}
					{#key data.pump.id + data.selected.day}
						<form method="POST" action="?/request" class="ask" use:enhance data-testid="reg-form">
							<input type="hidden" name="pump_id" value={data.pump.id} />
							<input type="hidden" name="day" value={data.selected.day} />
							<fieldset>
								<legend>Why was no photo taken?</legend>
								<div class="reasons">
									{#each Object.entries(REASON_TEXT) as [key, text] (key)}
										<label class="pick"
											><input type="radio" name="reason" value={key} required />
											<span aria-hidden="true">{text.icon}</span>
											{text.en}</label
										>
									{/each}
								</div>
							</fieldset>
							<label class="field"
								><span>Note (needed for Something else)</span><input
									name="note"
									maxlength="500"
								/></label
							>
							<fieldset>
								<legend
									>{half ? 'Whose photo was missed?' : 'Who worked that day?'} Untick who was not there.</legend
								>
								{#if data.crew.crew.length}
									<div class="crew">
										{#each data.crew.crew as c (c.personId)}
											<label class="pick"
												><input
													type="checkbox"
													name="workers"
													value={c.personId}
													checked={c.ticked}
												/>
												<span
													>{c.label}{#if c.half}<small class="half">{HALF_TEXT[c.half].en}</small
														>{/if}</span
												></label
											>
										{/each}
									</div>
								{:else}
									<p class="muted" data-testid="reg-no-crew">
										No one to select: no worker has attendance at this pump yet.
									</p>
								{/if}
							</fieldset>
							<div class="actions">
								<button
									class="button button--primary"
									type="submit"
									disabled={!data.crew.crew.length}
									data-testid="reg-send"
									>{role === 'admin' ? 'Regularise now' : 'Send for approval'}</button
								>
							</div>
						</form>
					{/key}
				{:else if !data.selected}
					<p class="muted small">Tap a red day to apply, or any day to see what happened.</p>
				{/if}
			</div>
		</section>
	{/if}

	<section class="section" aria-labelledby="all-heading">
		<h2 id="all-heading">Requests <span class="count">{others.length}</span></h2>
		{#if others.length}
			<ul class="cards bounded" data-testid="reg-list">
				{#each others as r (r.id)}
					<li
						class="card surface surface--padded"
						data-testid="reg-row"
						data-status={r.status}
						data-pump={r.pumpCode}
					>
						<div class="card__head">
							<strong class="day">{formatHumanDay(r.day)}</strong>
							<span>{r.pumpCode} · {r.plantName}</span>
							<span class="status status--{r.status}">{STATUS_TEXT[r.status]}</span>
						</div>
						<RegularisationEvidence {r} {role} />
						{#if r.status !== 'pending' && r.decidedAt}
							<p class="small">
								{STATUS_TEXT[r.status]}{r.decidedByName ? ` by ${r.decidedByName}` : ''} on {r.decidedAt}{#if r.decisionReason}:
									<strong>{r.decisionReason}</strong>{/if}
							</p>
						{:else if r.status === 'pending'}
							<p class="small muted">Waiting for {r.approverName ?? 'the admins'}.</p>
						{/if}
						{@render rowMessage(r)}
						{#if r.canCancel}
							<form method="POST" action="?/cancel" use:enhance={keep}>
								<input type="hidden" name="id" value={r.id} />
								<button class="button button--quiet" type="submit" data-testid="reg-cancel"
									>Withdraw</button
								>
							</form>
						{/if}
						{#if role === 'admin' && r.status === 'approved'}
							<form method="POST" action="?/undo" class="reject" use:enhance={keep}>
								<input type="hidden" name="id" value={r.id} />
								<label class="field"
									><span>Why undo?</span><input
										name="reason"
										minlength="5"
										maxlength="500"
										required
									/></label
								>
								<button class="button button--danger" type="submit" data-testid="reg-undo"
									>Undo</button
								>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<EmptyState
				title="No requests yet"
				description="Requests and their outcome are listed here, newest first."
			/>
		{/if}
	</section>
</div>

<style>
	.cards {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-3);
	}
	.bounded {
		max-height: 70vh;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.card {
		display: grid;
		gap: var(--space-2);
		min-width: 0;
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
	.small {
		font-size: var(--text-sm);
		margin: 0;
	}
	.reject {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: flex-end;
	}
	.status {
		font-size: var(--text-sm);
		font-weight: 600;
		padding: 0 var(--space-2);
		border-radius: var(--radius-sm);
		background: var(--surface-muted);
	}
	.status--approved {
		background: var(--primary-tint);
		color: var(--primary-pressed);
	}
	.status--rejected,
	.status--undone {
		background: var(--alert-tint);
		color: var(--alert);
	}
	.picker {
		max-width: 30rem;
	}
	.picker select {
		width: 100%;
	}
	.apply {
		display: grid;
		gap: var(--space-4);
		min-width: 0;
	}
	.ask {
		display: grid;
		gap: var(--space-3);
		width: 100%;
		max-width: 30rem;
		margin-inline: auto;
	}
	.half {
		display: block;
		color: var(--alert);
		font-size: var(--text-sm);
		font-weight: 600;
	}
	fieldset {
		border: 0;
		padding: 0;
		margin: 0;
		display: grid;
		gap: var(--space-2);
	}
	legend {
		font-weight: 600;
		margin-bottom: var(--space-2);
	}
	.reasons,
	.crew {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.pick input {
		flex: none;
		width: 1.25rem;
		height: 1.25rem;
		min-height: 0;
		margin: 0;
	}
	.pick {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--surface-muted);
		border-radius: var(--radius-md);
		min-height: 2.75rem;
	}
</style>
