<script lang="ts">
	import Eye from '@lucide/svelte/icons/eye';
	import Flag from '@lucide/svelte/icons/flag';
	import ScanFace from '@lucide/svelte/icons/scan-face';
	import X from '@lucide/svelte/icons/x';
	import StatusBadge from '$lib/components/StatusBadge.svelte';

	type PersonEvidence = {
		personId: string;
		label: string;
		cropUrl: string | null;
		flagged?: boolean;
	};

	type SessionEvidence = {
		id: string;
		sessionType: 'morning' | 'evening';
		groupPhotoUrl: string | null;
		groupFlagged?: boolean;
		people: PersonEvidence[];
	};

	type SelectedEvidence = {
		sessionId: string;
		personId: string | null;
		title: string;
		description: string;
		url: string;
		flagged: boolean;
	};

	// collapsePeople folds long worker lists behind a disclosure so table rows stay short.
	let {
		session,
		showUnavailable = true,
		collapsePeople = false
	}: { session: SessionEvidence; showUnavailable?: boolean; collapsePeople?: boolean } = $props();

	const folded = $derived(collapsePeople && session.people.length > 3);

	let dialog: HTMLDialogElement;
	let selected = $state<SelectedEvidence | null>(null);

	function openEvidence(evidence: SelectedEvidence) {
		selected = evidence;
		dialog.showModal();
	}

	function close() {
		dialog.close();
		selected = null;
	}
</script>

<div
	class="evidence-actions"
	aria-label="{session.sessionType} attendance evidence"
	data-testid="evidence-actions"
	data-session-id={session.id}
>
	{#if session.groupPhotoUrl}
		<button
			class="button button--secondary evidence-button"
			type="button"
			onclick={() =>
				openEvidence({
					sessionId: session.id,
					personId: null,
					title: `${session.sessionType} group photo`,
					description: 'Original group attendance submission',
					url: session.groupPhotoUrl!,
					flagged: Boolean(session.groupFlagged)
				})}
		>
			<Eye size={16} /> View group
		</button>
	{:else if showUnavailable}
		<span class="evidence-unavailable">Group photo unavailable</span>
	{/if}

	{#snippet personButton(person: PersonEvidence)}
		{#if person.cropUrl}
			<button
				class="button button--secondary evidence-button"
				type="button"
				onclick={() =>
					openEvidence({
						sessionId: session.id,
						personId: person.personId,
						title: person.label,
						description: `${session.sessionType} face detected in this group`,
						url: person.cropUrl!,
						flagged: Boolean(person.flagged)
					})}
			>
				<ScanFace size={16} /> View {person.label}
			</button>
		{:else if showUnavailable}
			<span class="evidence-unavailable">{person.label} photo unavailable</span>
		{/if}
	{/snippet}

	{#if folded}
		<details class="evidence-people" data-testid="evidence-people">
			<summary>{session.people.length} workers</summary>
			<div class="evidence-people__list">
				{#each session.people as person}{@render personButton(person)}{/each}
			</div>
		</details>
	{:else}
		{#each session.people as person}{@render personButton(person)}{/each}
	{/if}
</div>

<dialog
	bind:this={dialog}
	class="evidence-dialog"
	aria-labelledby="evidence-title"
	onclose={() => (selected = null)}
>
	{#if selected}
		<div class="evidence-dialog__header">
			<div>
				<p class="eyebrow">{session.sessionType} evidence</p>
				<h2 id="evidence-title">{selected.title}</h2>
				<p>{selected.description}</p>
			</div>
			<button class="icon-button" type="button" title="Close evidence viewer" onclick={close}>
				<X size={20} />
			</button>
		</div>

		<div class="evidence-dialog__image">
			<img src={selected.url} alt={selected.title} />
		</div>

		{#if selected.flagged}
			<StatusBadge tone="attention" label="Error flagged for admin review" />
		{:else}
			<form class="flag-form" method="POST" action="?/flagEvidence">
				<input type="hidden" name="session_id" value={selected.sessionId} />
				<input type="hidden" name="person_id" value={selected.personId || ''} />
				<label class="field">
					<span>Reason</span>
					<select name="reason" required>
						<option value="">Choose a reason</option>
						<option value="incorrect_match">Incorrect person match</option>
						<option value="missing_person">Person missing from attendance</option>
						<option value="wrong_session">Wrong session or date</option>
						<option value="poor_photo">Photo quality issue</option>
						<option value="other">Other issue</option>
					</select>
				</label>
				<label class="field">
					<span>Review note <small>Optional</small></span>
					<textarea name="note" maxlength="500" rows="2"></textarea>
				</label>
				<button class="button button--danger" type="submit"><Flag size={16} /> Flag error</button>
			</form>
		{/if}
	{/if}
</dialog>

<style>
	.evidence-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		min-width: 12rem;
	}
	.evidence-button {
		min-height: 2.25rem;
		padding: var(--space-1) var(--space-2);
		font-size: var(--text-xs);
	}
	.evidence-people {
		flex-basis: 100%;
	}
	.evidence-people summary {
		cursor: pointer;
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
	}
	.evidence-people__list {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}
	.evidence-unavailable {
		align-self: center;
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}
	.evidence-dialog {
		width: min(52rem, calc(100vw - 2rem));
		max-height: calc(100vh - 2rem);
		padding: 0;
		overflow: auto;
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-lg);
	}
	.evidence-dialog::backdrop {
		background: rgb(18 35 38 / 62%);
	}
	.evidence-dialog__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-4);
		padding: var(--space-4);
		border-bottom: 1px solid var(--brand-mist);
	}
	.evidence-dialog__header h2,
	.evidence-dialog__header p {
		margin: 0;
	}
	.evidence-dialog__header h2 {
		font-size: var(--text-xl);
	}
	.evidence-dialog__header p:last-child {
		margin-top: var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.evidence-dialog__image {
		display: grid;
		min-height: 16rem;
		max-height: 32rem;
		place-items: center;
		padding: var(--space-4);
		overflow: hidden;
		background: var(--surface-muted);
	}
	.evidence-dialog__image img {
		display: block;
		width: 100%;
		height: 100%;
		max-height: 30rem;
		object-fit: contain;
	}
	.evidence-dialog > :global(.status-badge) {
		margin: var(--space-4);
	}
	.flag-form {
		display: grid;
		grid-template-columns: minmax(12rem, 0.8fr) minmax(14rem, 1.2fr) auto;
		align-items: end;
		gap: var(--space-3);
		padding: var(--space-4);
		border-top: 1px solid var(--brand-mist);
	}
	.flag-form textarea {
		resize: vertical;
	}
	.flag-form small {
		color: var(--ink-muted);
		font-weight: 400;
	}
	.eyebrow {
		margin: 0 0 var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
	}
	@media (max-width: 44rem) {
		.flag-form {
			grid-template-columns: 1fr;
		}
		.flag-form .button {
			width: 100%;
		}
	}
</style>
