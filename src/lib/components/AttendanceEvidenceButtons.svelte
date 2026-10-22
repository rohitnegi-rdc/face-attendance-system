<script lang="ts">
	import Eye from '@lucide/svelte/icons/eye';
	import Flag from '@lucide/svelte/icons/flag';
	import ScanFace from '@lucide/svelte/icons/scan-face';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import X from '@lucide/svelte/icons/x';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { shiftTypeLabel } from '$lib/shiftLabels';

	type PersonEvidence = {
		personId: string;
		label: string;
		cropUrl: string | null;
		flagged?: boolean;
	};

	// Cross-pump fraud (src/lib/server/sessionEvidence.ts). flagged: this photo is where the face
	// was refused; matched: this photo is where the person was already counted.
	type FraudEvidence = {
		flagId: string;
		cropUrl: string | null;
		side: 'flagged' | 'matched';
		otherPump: string;
		otherPlant: string;
		similarity: number;
		isOperator: boolean;
		state: 'open' | 'confirmed' | 'cleared';
	};

	type SessionEvidence = {
		id: string;
		sessionType: 'morning' | 'evening';
		groupPhotoUrl: string | null;
		groupFlagged?: boolean;
		people: PersonEvidence[];
		fraud?: FraudEvidence[];
	};

	type SelectedEvidence = {
		sessionId: string;
		personId: string | null;
		title: string;
		description: string;
		url: string;
		flagged: boolean;
		fraud?: FraudEvidence;
	};

	// Fraud faces show as image tiles; every other worker as a name chip whose face loads when
	// opened (keeps the page light: crops are ~17 KB each). All sit next to the group photo button,
	// in a fixed-height area that scrolls when the group is large. allowFlag shows the "Flag error" form, which posts to
	// the page's ?/flagEvidence action; turn it off on pages without that action (view-only roles).
	let {
		session,
		showUnavailable = true,
		allowFlag = true,
		fraudCaseHref
	}: {
		session: SessionEvidence;
		showUnavailable?: boolean;
		allowFlag?: boolean;
		// The read-only side-by-side page for a fraud case, where the role has one.
		fraudCaseHref?: (flagId: string) => string;
	} = $props();

	const fraud = $derived(session.fraud ?? []);

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

	function fraudTitle(item: FraudEvidence) {
		return item.side === 'flagged'
			? `Same person as at ${item.otherPump}`
			: `Also seen at ${item.otherPump}`;
	}

	function fraudDescription(item: FraudEvidence) {
		const where = `${item.otherPump} (${item.otherPlant})`;
		const how = `face match ${Math.round(item.similarity * 100)}%`;
		const base =
			item.side === 'flagged'
				? `This face was already counted at ${where}, ${how}. It is not counted in this photo.`
				: `This person, counted in this photo, also turned up in a photo at ${where}, ${how}.`;
		if (item.state === 'cleared') return `${base} An admin checked it: not fraud.`;
		if (item.state === 'confirmed') return `${base} An admin confirmed it as fraud.`;
		return `${base} Waiting for an admin to decide.`;
	}

	function fraudStateLabel(item: FraudEvidence) {
		return item.state === 'cleared' ? 'Cleared' : item.state === 'confirmed' ? 'Fraud' : 'Fraud?';
	}
</script>

<div
	class="evidence-actions"
	aria-label="{shiftTypeLabel(session.sessionType)} attendance evidence"
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
					title: `${shiftTypeLabel(session.sessionType)} group photo`,
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

	{#if fraud.length || session.people.length}
		<div class="evidence-people" data-testid="evidence-people">
			{#each fraud as item (item.flagId + item.side)}
				<button
					class="face-tile face-tile--fraud"
					class:face-tile--cleared={item.state === 'cleared'}
					type="button"
					title={fraudTitle(item)}
					aria-label="View fraud: {fraudTitle(item)}"
					data-testid="fraud-face"
					disabled={!item.cropUrl}
					onclick={() =>
						openEvidence({
							sessionId: session.id,
							personId: null,
							title: fraudTitle(item),
							description: fraudDescription(item),
							url: item.cropUrl!,
							flagged: false,
							fraud: item
						})}
				>
					{#if item.cropUrl}
						<img src={item.cropUrl} alt="" />
					{:else}
						<span class="face-tile__empty"><TriangleAlert size={18} /></span>
					{/if}
					<span class="face-tile__label"
						><strong>{fraudStateLabel(item)}</strong>
						{item.side === 'flagged' ? 'as' : 'also'}
						{item.otherPump}</span
					>
				</button>
			{/each}
			{#each session.people as person}
				{#if person.cropUrl}
					<!-- A name only; the face loads when opened (fraud faces above stay on screen). -->
					<button
						class="face-tile face-chip"
						class:face-tile--flagged={person.flagged}
						type="button"
						title={person.label}
						aria-label="View face of {person.label}"
						data-testid="worker-chip"
						onclick={() =>
							openEvidence({
								sessionId: session.id,
								personId: person.personId,
								title: person.label,
								description: `${shiftTypeLabel(session.sessionType)} face detected in this group`,
								url: person.cropUrl!,
								flagged: Boolean(person.flagged)
							})}
					>
						<ScanFace size={15} aria-hidden="true" />
						<span class="face-chip__label">{person.label}</span>
					</button>
				{:else if showUnavailable}
					<span class="face-tile face-chip face-tile--missing" title="{person.label} photo unavailable">
						<ScanFace size={15} aria-hidden="true" />
						<span class="face-chip__label">{person.label}</span>
					</span>
				{/if}
			{/each}
		</div>
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
				<p class="eyebrow">{shiftTypeLabel(session.sessionType)} evidence</p>
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

		{#if selected.fraud}
			<p class="fraud-note" class:fraud-note--cleared={selected.fraud.state === 'cleared'}>
				<TriangleAlert size={16} />
				{selected.fraud.state === 'cleared'
					? 'Checked by an admin: not fraud.'
					: 'Fraud check: the same person at two pumps in this Area.'}
				{#if fraudCaseHref}
					<a class="fraud-note__link" href={fraudCaseHref(selected.fraud.flagId)}
						>See both places side by side</a
					>
				{/if}
			</p>
		{:else if selected.flagged}
			<StatusBadge tone="attention" label="Error flagged for admin review" />
		{:else if allowFlag}
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
		align-items: flex-start;
		gap: var(--space-2);
		min-width: 16rem;
	}
	.evidence-button {
		flex-shrink: 0;
		min-height: 2.25rem;
		padding: var(--space-1) var(--space-2);
		font-size: var(--text-xs);
	}
	/* Fixed height: a big group scrolls inside the cell instead of stretching the row. */
	.evidence-people {
		display: flex;
		flex: 1;
		flex-wrap: wrap;
		gap: var(--space-2);
		max-height: 9.5rem;
		min-width: 0;
		overflow-y: auto;
	}
	.face-tile {
		display: grid;
		width: 4.25rem;
		justify-items: center;
		align-content: start;
		gap: 0.15rem;
		padding: 0.2rem;
		color: var(--ink-default);
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
		cursor: pointer;
		font: inherit;
	}
	.face-tile:hover:not(:disabled) {
		border-color: var(--brand-teal);
	}
	.face-tile img,
	.face-tile__empty {
		display: grid;
		width: 2.75rem;
		height: 2.75rem;
		place-items: center;
		object-fit: cover;
		color: var(--ink-muted);
		background: var(--surface-muted);
		border-radius: var(--radius-sm);
	}
	.face-tile__label {
		max-width: 100%;
		font-size: 0.68rem;
		line-height: 1.2;
		text-align: center;
		overflow-wrap: anywhere;
	}
	/* Worker without fraud: a name chip, face on click. Fraud tiles keep the image. */
	.face-chip {
		display: inline-flex;
		width: auto;
		max-width: 11rem;
		align-items: center;
		gap: 0.3rem;
		padding: 0.3rem 0.55rem;
		color: var(--ink-default);
		border-radius: 999px;
	}
	.face-chip :global(svg) {
		flex: none;
		color: var(--brand-teal);
	}
	.face-chip__label {
		overflow: hidden;
		font-size: var(--text-xs);
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.face-tile--missing.face-chip :global(svg) {
		color: var(--ink-muted);
	}
	.face-tile--flagged {
		border-color: var(--ink-strong);
		border-style: dashed;
	}
	.face-tile--missing {
		cursor: default;
	}
	.face-tile--fraud {
		color: var(--alert);
		background: var(--alert-tint);
		border: 2px solid var(--alert);
	}
	.face-tile--cleared {
		color: var(--ink-muted);
		background: var(--surface-subtle);
		border: 1px dashed var(--brand-steel);
	}
	.fraud-note {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin: var(--space-4);
		padding: var(--space-2) var(--space-3);
		color: var(--alert);
		background: var(--alert-tint);
		border: 1px solid var(--alert);
		border-radius: var(--radius-md);
		font-weight: 700;
	}
	.fraud-note__link {
		margin-left: auto;
		color: inherit;
		white-space: nowrap;
	}
	.fraud-note--cleared {
		color: var(--ink-muted);
		background: var(--surface-subtle);
		border-color: var(--brand-steel);
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
		.evidence-actions {
			flex-wrap: wrap;
		}
		.flag-form {
			grid-template-columns: 1fr;
		}
		.flag-form .button {
			width: 100%;
		}
	}
</style>
