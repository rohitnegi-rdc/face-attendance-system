<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Ban from '@lucide/svelte/icons/ban';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Image from '@lucide/svelte/icons/image';
	import ScanFace from '@lucide/svelte/icons/scan-face';
	import X from '@lucide/svelte/icons/x';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { shiftTypeLabel } from '$lib/shiftLabels';
	import type { FraudCase } from '$lib/server/fraudCase';

	// A cross-pump fraud case, read only: where the same face was counted first and where it was
	// refused, side by side, earliest on the left. The admin decides at /admin/fraud-flags.
	let {
		fraudCase,
		backHref,
		backLabel
	}: { fraudCase: FraudCase; backHref: string; backLabel: string } = $props();

	const c = $derived(fraudCase);
	const matchPct = $derived(Math.round(c.similarity * 100));

	const STATE = {
		open: { tone: 'critical', label: 'Waiting for admin' },
		confirmed: { tone: 'critical', label: 'Confirmed fraud' },
		cleared: { tone: 'neutral', label: 'Cleared, not fraud' }
	} as const;

	// "1 h 12 min later", "3 days later", "12 min earlier".
	function gapText(minutes: number) {
		const abs = Math.abs(minutes);
		const when = minutes < 0 ? 'earlier' : 'later';
		if (abs < 1) return 'Same minute';
		if (abs < 60) return `${abs} min ${when}`;
		if (abs < 48 * 60) {
			const h = Math.floor(abs / 60);
			const m = abs % 60;
			return `${h} h${m ? ` ${m} min` : ''} ${when}`;
		}
		return `${Math.round(abs / 1440)} days ${when}`;
	}

	let dialog: HTMLDialogElement;
	let photo = $state<{ url: string; title: string } | null>(null);
	function openPhoto(url: string, title: string) {
		photo = { url, title };
		dialog.showModal();
	}
</script>

{#snippet sightingCard(kind: 'first' | 'refused')}
	{@const s = kind === 'first' ? c.first : c.refused}
	<article
		class="sighting"
		class:sighting--refused={kind === 'refused'}
		data-testid="fraud-sighting-{kind}"
	>
		<h2 class="sighting__role">
			{#if kind === 'first'}
				<CircleCheck size={18} aria-hidden="true" /> Counted first
			{:else}
				<Ban size={18} aria-hidden="true" /> Refused here
			{/if}
		</h2>
		<div class="sighting__pump">
			<strong>{s.pump}</strong>
			<span>{s.plant} · {s.area}</span>
		</div>
		<figure class="sighting__face">
			{#if s.face}
				<img src={s.face} alt="Face at {s.pump}" />
			{:else}
				<span class="sighting__face-empty"><ScanFace size={28} /><small>No face saved</small></span>
			{/if}
		</figure>
		<dl class="facts">
			<div class="fact">
				<dt>Photo sent</dt>
				<dd>
					<span class="fact__time">{s.sentTime}</span>
					<span class="fact__date">{s.sentDate}</span>
				</dd>
			</div>
			<div class="fact">
				<dt>Shift</dt>
				<dd>
					<span class="fact__strong">{shiftTypeLabel(s.sessionType)}</span>
					<span class="fact__date">{s.shiftDate}</span>
				</dd>
			</div>
			<div class="fact">
				<dt>Vendor</dt>
				<dd>{s.vendor}</dd>
			</div>
			<div class="fact">
				<dt>{kind === 'first' ? 'Counted as' : 'Attendance'}</dt>
				<dd>
					{#if kind === 'first'}
						{c.first.countedAs}
					{:else}
						Not counted{c.refused.fromOperatorPhoto ? ' (operator photo)' : ''}
					{/if}
				</dd>
			</div>
		</dl>
		<div class="sighting__action">
			{#if s.groupPhotoUrl}
				<button
					class="button button--secondary"
					type="button"
					onclick={() => openPhoto(s.groupPhotoUrl!, `Group photo at ${s.pump}`)}
				>
					<Image size={16} /> View group photo
				</button>
			{:else}
				<small class="muted">Group photo is kept by the plant manager of {s.plant}.</small>
			{/if}
		</div>
	</article>
{/snippet}

<div class="page fraud-case">
	<a class="back" href={backHref}><ArrowLeft size={16} /> {backLabel}</a>

	<header class="case-head">
		<h1>Same person at two pumps</h1>
		<div class="case-meta">
			<StatusBadge tone={STATE[c.state].tone} label={STATE[c.state].label} />
			<span>Face match <strong>{matchPct}%</strong></span>
			<span>Found <strong>{c.foundDate}, {c.foundTime}</strong></span>
		</div>
	</header>

	<div class="comparison" data-testid="fraud-comparison">
		{@render sightingCard('first')}
		<div class="link" role="note" aria-label="{matchPct}% face match, {gapText(c.gapMinutes)}">
			<span class="link__match">{matchPct}%</span>
			<span class="link__label">face match</span>
			<span class="link__arrow"><ArrowRight size={20} aria-hidden="true" /></span>
			<span class="link__gap">{gapText(c.gapMinutes)}</span>
		</div>
		{@render sightingCard('refused')}
	</div>

	<section class="next">
		<h2>What happens next</h2>
		{#if c.state === 'open'}
			<p>
				The face at {c.refused.pump} is not counted while an admin checks this case. If it is not fraud,
				the admin marks it and the worker is counted at {c.refused.pump}. If it is, it stays
				refused. Nothing is needed from you; call the pumps if you want to know more.
			</p>
		{:else if c.state === 'confirmed'}
			<p>An admin confirmed this as fraud. The face stays not counted at {c.refused.pump}.</p>
		{:else}
			<p>
				An admin checked this case{c.resolvedDate ? ` on ${c.resolvedDate}` : ''}: not fraud. The
				worker is counted at {c.refused.pump}.
			</p>
		{/if}
	</section>
</div>

<dialog bind:this={dialog} class="photo-dialog" onclose={() => (photo = null)}>
	{#if photo}
		<div class="photo-dialog__head">
			<h2>{photo.title}</h2>
			<button class="icon-button" type="button" aria-label="Close" onclick={() => dialog.close()}>
				<X size={20} />
			</button>
		</div>
		<img src={photo.url} alt={photo.title} />
	{/if}
</dialog>

<style>
	.fraud-case {
		display: grid;
		gap: var(--space-6);
		max-width: 64rem;
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		justify-self: start;
		min-height: 2.75rem;
		color: var(--ink-muted);
		font-weight: 600;
		text-decoration: none;
	}
	.back:hover {
		color: var(--ink-strong);
	}

	.case-head {
		display: grid;
		gap: var(--space-3);
	}
	.case-head h1 {
		margin: 0;
		text-wrap: balance;
	}
	.case-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-5);
		color: var(--ink-muted);
	}
	.case-meta strong {
		color: var(--ink-strong);
		font-variant-numeric: tabular-nums;
	}

	/* Two sightings on shared rows (subgrid), so pump, face, time and shift line up across. */
	.comparison {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		grid-template-rows: repeat(5, auto);
		column-gap: var(--space-4);
	}
	.sighting {
		display: grid;
		grid-row: span 5;
		grid-template-rows: subgrid;
		row-gap: var(--space-4);
		padding: var(--space-5);
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-lg);
	}
	.sighting--refused {
		background: var(--alert-tint);
		border-color: var(--alert);
	}
	.sighting__role {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		color: var(--primary-pressed);
		font-size: var(--text-sm);
		font-weight: 700;
	}
	.sighting--refused .sighting__role {
		color: var(--alert);
	}
	.sighting__pump {
		display: grid;
		gap: 2px;
	}
	.sighting__pump strong {
		color: var(--ink-strong);
		font-size: var(--text-xl);
		line-height: 1.2;
		overflow-wrap: anywhere;
	}
	.sighting__pump span {
		color: var(--ink-muted);
	}
	.sighting__face {
		margin: 0;
	}
	.sighting__face img,
	.sighting__face-empty {
		display: grid;
		width: 9rem;
		aspect-ratio: 1;
		place-content: center;
		justify-items: center;
		gap: var(--space-1);
		object-fit: cover;
		color: var(--ink-muted);
		background: var(--surface-muted);
		border-radius: var(--radius-lg);
	}
	.facts {
		display: grid;
		margin: 0;
		border-top: 1px solid var(--brand-mist);
	}
	.fact {
		display: grid;
		grid-template-columns: 7.5rem minmax(0, 1fr);
		gap: var(--space-3);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--brand-mist);
	}
	.sighting--refused .facts,
	.sighting--refused .fact {
		border-color: rgb(198 40 40 / 25%);
	}
	.fact dt {
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.fact dd {
		display: grid;
		margin: 0;
		color: var(--ink-strong);
		font-variant-numeric: tabular-nums;
	}
	.fact__time {
		font-size: var(--text-lg);
		font-weight: 700;
	}
	.fact__strong {
		font-weight: 600;
	}
	.fact__date {
		color: var(--ink-default);
		font-size: var(--text-sm);
	}
	.sighting__action {
		align-self: end;
	}
	.muted {
		color: var(--ink-muted);
	}

	.link {
		display: grid;
		grid-row: 1 / span 5;
		grid-column: 2;
		align-content: center;
		justify-items: center;
		gap: var(--space-1);
		min-width: 6.5rem;
		text-align: center;
	}
	.link__match {
		color: var(--ink-strong);
		font-size: var(--text-xl);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	.link__label,
	.link__gap {
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 600;
	}
	.link__arrow {
		display: grid;
		width: 2.5rem;
		height: 2.5rem;
		place-items: center;
		margin: var(--space-1) 0;
		color: var(--ink-default);
		background: var(--surface-muted);
		border-radius: 999px;
	}

	.next {
		display: grid;
		gap: var(--space-2);
		max-width: 70ch;
	}
	.next h2 {
		margin: 0;
		font-size: var(--text-lg);
	}
	.next p {
		margin: 0;
		color: var(--ink-default);
	}

	.photo-dialog {
		width: min(56rem, calc(100vw - 2rem));
		max-height: calc(100vh - 2rem);
		padding: 0;
		overflow: auto;
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
	}
	.photo-dialog::backdrop {
		background: rgb(18 35 38 / 62%);
	}
	.photo-dialog__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		padding: var(--space-3) var(--space-4);
		border-bottom: 1px solid var(--brand-mist);
	}
	.photo-dialog__head h2 {
		margin: 0;
		font-size: var(--text-lg);
	}
	.photo-dialog img {
		display: block;
		width: 100%;
		max-height: 75vh;
		object-fit: contain;
		background: var(--surface-muted);
	}

	/* Phone and narrow tablet: one column, the match between the two cards, arrow pointing down. */
	@media (max-width: 52rem) {
		.comparison {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: none;
			row-gap: var(--space-3);
		}
		.sighting {
			grid-row: auto;
			grid-template-rows: none;
			padding: var(--space-4);
		}
		.link {
			grid-row: auto;
			grid-column: auto;
			grid-auto-flow: column;
			justify-content: center;
			align-items: center;
			gap: var(--space-2);
		}
		.link__arrow {
			margin: 0;
			transform: rotate(90deg);
		}
		.sighting__face img,
		.sighting__face-empty {
			width: 7.5rem;
		}
		.fact {
			grid-template-columns: 6rem minmax(0, 1fr);
		}
	}
</style>
