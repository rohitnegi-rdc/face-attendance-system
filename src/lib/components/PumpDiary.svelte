<script lang="ts">
	// One pump, day by day (newest first): the status that day, who was counted for it, and every
	// photo sent that day by the time it was sent, with the shift it counted for. A night shift's end
	// photo sent this morning says it counts for yesterday; a refused photo shows the reason the
	// operator saw. Every day of the range is listed, nothing hidden.
	import ShiftSplit from '$lib/components/ShiftSplit.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatHumanDay, formatTime } from '$lib/date';
	import { PUMP_WORK_STATUS_LABELS } from '$lib/pumpWorkStatus';
	import { shiftTypeLabel } from '$lib/shiftLabels';
	import type { DiaryDay, DiaryEvent } from '$lib/server/pumpDiary';

	type Counts = { present: number; morningOnly: number; eveningOnly: number };
	let { days, counts }: { days: DiaryDay[]; counts: Record<string, Counts> } = $props();

	const CLOSED_HOW = {
		pump: 'the pump pressed End session',
		timeout: 'no end photo came in time',
		admin: 'closed by an admin'
	} as const;
	const PHOTO_RESULT: Record<string, string> = {
		completed: 'Processed',
		pending: 'Waiting to be processed',
		processing: 'Being processed',
		review: 'Held for review',
		failed: 'Failed',
		fraud_detected: 'Fraud flag'
	};
	const total = (c: Counts | undefined) => (c ? c.present + c.morningOnly + c.eveningOnly : 0);
	const shortDay = (day: string) => formatHumanDay(day).replace(/ \d{4}$/, '');
	// Separators as expressions: Svelte trims whitespace that opens a block or an element.
	const SEP = ' · ';
	const nightTag = (e: Extract<DiaryEvent, { kind: 'photo' }>) =>
		e.shift === 'evening' ? ' (night shift)' : '';
	const photoResult = (e: Extract<DiaryEvent, { kind: 'photo' }>) =>
		(PHOTO_RESULT[e.status] ?? e.status) +
		(e.error ? `: ${e.error}` : '') +
		(e.testMode ? ' · test mode' : '');
	const bad = (e: DiaryEvent) =>
		e.kind === 'refused' ||
		(e.kind === 'photo' && (e.status === 'failed' || e.status === 'fraud_detected'));
</script>

<ol class="diary" data-testid="pump-diary">
	{#each days as d (d.day)}
		{@const c = counts[d.day]}
		{@const none = total(c) === 0}
		<li
			class="day"
			class:day--none={none && d.status === 'active'}
			data-testid="diary-day"
			data-day={d.day}
		>
			<div class="day__head">
				<strong>{formatHumanDay(d.day)}</strong>
				<StatusBadge
					tone={d.status === 'active' ? 'success' : d.status === 'idle' ? 'pending' : 'neutral'}
					label={PUMP_WORK_STATUS_LABELS[d.status]}
				/>
				{#if d.siteName && d.status !== 'inactive'}<small class="muted">{d.siteName}</small>{/if}
			</div>
			<p class="day__counted" data-testid="diary-counted">
				{#if none}
					<span class:alert-text={d.status === 'active'}
						>{d.status === 'idle' ? 'Idle, no work' : 'Nobody counted for this day'}</span
					>
				{:else}
					<ShiftSplit
						full={c.present}
						startOnly={c.morningOnly}
						endOnly={c.eveningOnly}
						testId="diary-split"
					/>
				{/if}
			</p>
			{#if d.events.length}
				<ul class="events">
					{#each d.events as e, i (i)}
						<li
							class="event"
							class:event--bad={bad(e)}
							data-testid="diary-event"
							data-kind={e.kind}
						>
							<time datetime={e.at}>{formatTime(e.at)}</time>
							<span>
								{#if e.kind === 'photo'}
									<strong>{shiftTypeLabel(e.shift)} photo sent</strong
									>{#if e.countedFor !== d.day}{SEP}counts for
										<strong>{shortDay(e.countedFor)}</strong>{nightTag(e)}{/if}{SEP}{photoResult(e)}
								{:else if e.kind === 'closed'}
									Shift of {shortDay(e.countedFor)} closed without an end photo: {CLOSED_HOW[e.by]}
								{:else}
									<strong>Photo refused:</strong> {e.reason}
								{/if}
							</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="nothing" class:alert-text={d.status === 'active'}>Nothing sent this day</p>
			{/if}
		</li>
	{/each}
</ol>

<style>
	.diary {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-2);
		max-height: 32rem;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.day {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-3);
		border: 1px solid var(--surface-muted);
		border-radius: var(--radius-md);
		min-width: 0;
	}
	.day--none {
		background: var(--alert-tint);
	}
	.day__head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-2);
	}
	.day__counted,
	.nothing {
		margin: 0;
		font-size: var(--text-sm);
	}
	.alert-text {
		color: var(--alert);
		font-weight: 600;
	}
	.events {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-1);
	}
	.event {
		display: grid;
		grid-template-columns: 4.5rem minmax(0, 1fr);
		gap: var(--space-2);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
	.event time {
		font-variant-numeric: tabular-nums;
		color: var(--ink-default);
	}
	.event--bad {
		color: var(--alert);
	}
	.muted {
		color: var(--ink-default);
	}
</style>
