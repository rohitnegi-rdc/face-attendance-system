<script module lang="ts">
	import type { ComponentProps } from 'svelte';
	import type AttendanceEvidenceButtonsType from '$lib/components/AttendanceEvidenceButtons.svelte';

	export type ShiftLogSession = {
		id: string;
		status: string;
		submitted_at: string;
		location_status: string;
		error_reason: string | null;
		pairing_status: string;
		closed_by?: string | null;
		evidence: ComponentProps<typeof AttendanceEvidenceButtonsType>['session'];
	};
	export type ShiftLogShift<S> = {
		key: string;
		session_date: string;
		pump_id: string;
		pump_code: string;
		plant_name: string;
		start: S[];
		end: S[];
		fraudPumps: string[];
	};
</script>

<script lang="ts" generics="S extends ShiftLogSession">
	// The session log of the plant manager and admin pump pages: one heading per day, one numbered
	// row per shift with its start and end photos. Phone: the row stacks (who, start, end); wide
	// screens put start and end side by side for comparison. Pages add their own per-photo tools
	// (admin fixes) through the actions snippet.
	import type { Snippet } from 'svelte';
	import Wrench from '@lucide/svelte/icons/wrench';
	import AttendanceEvidenceButtons from '$lib/components/AttendanceEvidenceButtons.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import LocationBadge from '$lib/components/LocationBadge.svelte';
	import { dateKey, formatDate, formatTime } from '$lib/date';
	import { shiftOutcomeLabel } from '$lib/shiftLabels';

	type Shift = ShiftLogShift<S>;
	type Tone = 'success' | 'active' | 'pending' | 'critical' | 'attention' | 'neutral';

	let {
		shifts,
		page,
		pageSize,
		fixHref,
		fraudCaseHref,
		allowFlag = false,
		allowRename = false,
		actions
	}: {
		shifts: Shift[];
		page: number;
		pageSize: number;
		// Where Fix attendance goes for this shift's pump and day.
		fixHref: (shift: Shift, day: string) => string;
		fraudCaseHref?: (flagId: string) => string;
		allowFlag?: boolean;
		// A name box in the face popup (admin and plant manager).
		allowRename?: boolean;
		actions?: Snippet<[S]>;
	} = $props();

	// Shifts arrive newest day first; each day is one heading and its rows are numbered across
	// pages, so "row 17" means the same shift to everyone looking at this range.
	const logDays = $derived.by(() => {
		const out: { day: string; shifts: (Shift & { number: number })[] }[] = [];
		const offset = (page - 1) * pageSize;
		shifts.forEach((shift, i) => {
			const day = dateKey(shift.session_date);
			let group = out.at(-1);
			if (!group || group.day !== day) out.push((group = { day, shifts: [] }));
			group.shifts.push({ ...shift, number: offset + i + 1 });
		});
		return out;
	});
	const STATUS: Record<string, { label: string; tone: Tone }> = {
		completed: { label: 'Counted', tone: 'success' },
		review: { label: 'Waiting for pump to complete', tone: 'pending' },
		pending: { label: 'Processing', tone: 'pending' },
		processing: { label: 'Processing', tone: 'pending' },
		failed: { label: 'Failed', tone: 'critical' },
		fraud_detected: { label: 'Fraud', tone: 'critical' }
	};
	function statusLabel(status: string) {
		return STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
	}
	function outcome(shift: Shift): { label: string; tone: Tone } {
		const start = shift.start.find((s) => s.status !== 'failed') ?? shift.start[0];
		if (!start) return { label: 'End only', tone: 'attention' };
		const label = shiftOutcomeLabel(start);
		return {
			label,
			tone:
				label === 'Full shift' ? 'success' : label === 'Waiting for end' ? 'active' : 'attention'
		};
	}
	function halves(shift: Shift, result: string) {
		return [
			{ title: 'Shift start', sessions: shift.start, empty: 'No start photo' },
			{
				title: 'Shift end',
				sessions: shift.end,
				empty: result === 'Waiting for end' ? 'Waiting for the end photo' : 'No end photo'
			}
		];
	}
	function canFix(shift: Shift) {
		return [...shift.start, ...shift.end].some(
			(s) => s.status === 'completed' || s.status === 'review'
		);
	}
	// The time alone, or with the weekday when the photo was sent on another day than the shift.
	function sentLabel(sentAt: string, day: string) {
		return dateKey(sentAt) === day
			? formatTime(sentAt)
			: `${formatDate(sentAt).slice(0, 3)} ${formatTime(sentAt)}`;
	}
</script>

{#each logDays as group (group.day)}
	<section class="log-day" aria-labelledby="log-day-{group.day}">
		<h3 class="log-day__title" id="log-day-{group.day}">
			{formatDate(group.day)}
			<span>{group.shifts.length} {group.shifts.length === 1 ? 'shift' : 'shifts'}</span>
		</h3>
		<ol class="shift-list">
			{#each group.shifts as shift (shift.key)}
				{@const result = outcome(shift)}
				<li class="shift" class:shift--fraud={shift.fraudPumps.length > 0} data-testid="shift-row">
					<div class="shift__who">
						<span class="shift__number" title="Row {shift.number}">{shift.number}</span>
						<div class="shift__pump">
							<strong>{shift.pump_code}</strong>
							<small>{shift.plant_name}</small>
						</div>
						<div class="shift__tags">
							<StatusBadge tone={result.tone} label={result.label} />
							{#if shift.fraudPumps.length}<span
									class="fraud-row-badge"
									data-testid="fraud-row-badge">Same person at {shift.fraudPumps.join(', ')}</span
								>{/if}
						</div>
						{#if canFix(shift)}
							<a class="fix-link" href={fixHref(shift, group.day)} data-testid="fix-attendance"
								><Wrench size={15} /> Fix attendance</a
							>
						{/if}
					</div>
					{#each halves(shift, result.label) as half (half.title)}
						<div class="half">
							{#each half.sessions as session (session.id)}
								{@const status = statusLabel(session.status)}
								<div class="half__head">
									<span class="half__title">{half.title}</span>
									<span class="half__time">{sentLabel(session.submitted_at, group.day)}</span>
									<StatusBadge tone={status.tone} label={status.label} />
									{#if session.location_status !== 'approved'}<LocationBadge
											status={session.location_status}
										/>{/if}
								</div>
								{#if session.error_reason}<p class="half__note">{session.error_reason}</p>{/if}
								<AttendanceEvidenceButtons
									session={session.evidence}
									{allowFlag}
									{allowRename}
									{fraudCaseHref}
								/>
								{#if actions}<div class="half__actions">{@render actions(session)}</div>{/if}
							{:else}
								<div class="half__head"><span class="half__title">{half.title}</span></div>
								<p class="half__empty">{half.empty}</p>
							{/each}
						</div>
					{/each}
				</li>
			{/each}
		</ol>
	</section>
{/each}

<style>
	.log-day + .log-day {
		margin-top: var(--space-6);
	}
	.log-day__title {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		margin: 0 0 var(--space-3);
		padding-bottom: var(--space-2);
		font-size: var(--text-lg);
		font-weight: 800;
		border-bottom: 1px solid var(--brand-mist);
	}
	.log-day__title span {
		color: var(--ink-muted);
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.shift-list {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.shift {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-3);
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.shift--fraud {
		background: var(--alert-tint);
		border-color: var(--alert);
	}
	.shift__who {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
	}
	.shift__number {
		display: grid;
		min-width: 2rem;
		height: 2rem;
		padding: 0 0.45rem;
		place-items: center;
		color: var(--surface-raised);
		font-size: var(--text-sm);
		font-variant-numeric: tabular-nums;
		font-weight: 800;
		background: var(--ink-strong);
		border-radius: 999px;
	}
	.shift__pump {
		display: grid;
		line-height: 1.25;
	}
	.shift__pump small {
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}
	/* Phone: number, pump and Fix on the first line, the badges below. */
	.shift__tags {
		display: flex;
		flex-basis: 100%;
		flex-wrap: wrap;
		gap: var(--space-2);
		order: 3;
	}
	/* Every tool on the card (Fix attendance here, the page's per-photo tools below) is the same
	   compact outlined button, so none of them shouts louder than the photos. */
	.fix-link,
	.half__actions :global(.button) {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 2.75rem;
		padding: 0 var(--space-3);
		font-size: var(--text-sm);
		font-weight: 700;
		white-space: nowrap;
		text-decoration: none;
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.fix-link {
		margin-left: auto;
		color: var(--brand-teal);
	}
	.fix-link:hover {
		border-color: var(--brand-teal);
	}
	.half {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
		padding-top: var(--space-3);
		border-top: 1px solid var(--brand-mist);
	}
	.half__head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-2);
	}
	.half__head :global(.location-badge) {
		margin-top: 0;
	}
	.half__title {
		font-size: var(--text-sm);
		font-weight: 800;
	}
	.half__time {
		color: var(--ink-muted);
		font-size: var(--text-sm);
		font-variant-numeric: tabular-nums;
	}
	.half__note {
		margin: 0;
		color: var(--alert);
		font-size: var(--text-sm);
	}
	.half__empty {
		margin: 0;
		padding: var(--space-3);
		color: var(--ink-muted);
		font-size: var(--text-sm);
		border: 1px dashed var(--brand-steel);
		border-radius: var(--radius-md);
	}
	/* The tools sit on their own line under the faces; on wide screens they drop to the bottom of
	   both halves, so start and end tools line up whatever the number of faces. */
	.half__actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px dashed var(--brand-mist);
	}
	.half__actions:last-child {
		margin-top: auto;
	}
	@media (min-width: 64rem) {
		.shift {
			grid-template-columns: minmax(12rem, 15rem) minmax(0, 1fr) minmax(0, 1fr);
			align-items: stretch;
			column-gap: var(--space-4);
		}
		.shift__who {
			flex-direction: column;
			flex-wrap: nowrap;
			align-items: flex-start;
			align-self: start;
		}
		.shift__tags {
			order: 0;
		}
		.fix-link {
			order: 1;
			margin-top: var(--space-1);
			margin-left: 0;
		}
		.half {
			padding-top: 0;
			padding-left: var(--space-4);
			border-top: 0;
			border-left: 1px solid var(--brand-mist);
		}
	}
</style>
