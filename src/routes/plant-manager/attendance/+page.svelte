<script lang="ts">
	import { resolve } from '$app/paths';
	import Download from '@lucide/svelte/icons/download';
	import Search from '@lucide/svelte/icons/search';
	import Wrench from '@lucide/svelte/icons/wrench';
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import AttendanceEvidenceButtons from '$lib/components/AttendanceEvidenceButtons.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import LocationBadge from '$lib/components/LocationBadge.svelte';
	import { calendarDays, dateKey, formatDate, formatTime, todayStr } from '$lib/date';
	import { shiftOutcomeLabel } from '$lib/shiftLabels';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	const days = $derived(calendarDays(data.filters.from, data.filters.to));
	const entities = $derived(
		data.pumps.map((pump: any) => ({ id: pump.id, label: pump.pump_code }))
	);
	function sessionPageUrl(page: number) {
		const params = new URLSearchParams({ from: data.filters.from, to: data.filters.to });
		params.set('session_page', String(page));
		return `?${params.toString()}`;
	}
	type Shift = PageData['shifts'][number];
	type Session = Shift['start'][number];
	type Tone = 'success' | 'active' | 'pending' | 'critical' | 'attention' | 'neutral';
	// Shifts arrive newest day first; each day is one heading and its rows are numbered across
	// pages, so "row 17" means the same shift to everyone looking at this range.
	const logDays = $derived.by(() => {
		const out: { day: string; shifts: (Shift & { number: number })[] }[] = [];
		const offset = (data.sessionPagination.page - 1) * data.sessionPagination.pageSize;
		data.shifts.forEach((shift, i) => {
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
		const start = shift.start.find((s: Session) => s.status !== 'failed') ?? shift.start[0];
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
			(s: Session) => s.status === 'completed' || s.status === 'review'
		);
	}
	// The time alone, or with the weekday when the photo was sent on another day than the shift.
	function sentLabel(sentAt: string, day: string) {
		return dateKey(sentAt) === day
			? formatTime(sentAt)
			: `${formatDate(sentAt).slice(0, 3)} ${formatTime(sentAt)}`;
	}
	const lookup = $derived(
		new Map(
			data.daily.map((row: any) => [
				`${row.pump_id}:${dateKey(row.session_date)}`,
				Number(row.attendance_pct)
			])
		)
	);
</script>

<svelte:head><title>Plant attendance | Face Attendance</title></svelte:head>
<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Plant manager</p>
			<h1>Attendance</h1>
			<p>Attendance and session evidence for your assigned plants.</p>
		</div>
		<div class="header-actions">
			<a
				class="button button--secondary"
				href={resolve(
					`/plant-manager/attendance/export?${new URLSearchParams({ from: data.filters.from, to: data.filters.to })}`
				)}
				data-sveltekit-reload
			>
				<Download size={17} /> Export report
			</a>
			<form
				class="headcount-form"
				method="GET"
				action={resolve('/plant-manager/attendance/export')}
				data-sveltekit-reload
			>
				<input type="hidden" name="report" value="headcount" />
				<label class="field"
					><span>Headcount month</span><input
						type="month"
						name="month"
						value={todayStr().slice(0, 7)}
						max={todayStr().slice(0, 7)}
					/></label
				>
				<button class="button button--secondary" type="submit"
					><Download size={17} /> Headcount report</button
				>
			</form>
		</div>
	</header>
	<form class="filter-bar compact-filter" method="GET">
		<label class="field"
			><span>From</span><input type="date" name="from" value={data.filters.from} /></label
		><label class="field"
			><span>To</span><input type="date" name="to" value={data.filters.to} /></label
		>
		<div class="filter-actions">
			<button class="button button--primary" type="submit"><Search size={17} /> Apply</button>
		</div>
	</form>
	<section class="section">
		<div class="section-header">
			<div>
				<h2>Daily attendance</h2>
				<p class="supporting-text">Full shift (start and end) matches by pump.</p>
			</div>
		</div>
		{#if data.daily.length}<AttendanceCalendarGrid
				{days}
				{entities}
				mode="percent"
				cellValue={(entity, day) => lookup.get(`${entity}:${day}`) ?? null}
			/>{:else}<EmptyState
				title="No attendance in this range"
				description="Choose another date range."
			/>{/if}
	</section>
	<section class="section" aria-labelledby="session-log-title">
		<div class="section-header">
			<div>
				<h2 id="session-log-title">Session log and photos</h2>
				<p class="supporting-text">
					{data.sessionPagination.total}
					{data.sessionPagination.total === 1 ? 'shift' : 'shifts'} in this range, newest first. Each
					row is one shift, start photo and end photo side by side. Open a group photo or a worker to
					see who was counted.
				</p>
			</div>
		</div>
		{#if data.shifts.length}
			{#each logDays as group (group.day)}
				<section class="log-day" aria-labelledby="log-day-{group.day}">
					<h3 class="log-day__title" id="log-day-{group.day}">
						{formatDate(group.day)}
						<span>{group.shifts.length} {group.shifts.length === 1 ? 'shift' : 'shifts'}</span>
					</h3>
					<ol class="shift-list">
						{#each group.shifts as shift (shift.key)}
							{@const result = outcome(shift)}
							<li
								class="shift"
								class:shift--fraud={shift.fraudPumps.length > 0}
								data-testid="shift-row"
							>
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
												data-testid="fraud-row-badge"
												>Same person at {shift.fraudPumps.join(', ')}</span
											>{/if}
									</div>
									{#if canFix(shift)}
										<a
											class="fix-link"
											href={resolve(
												`/plant-manager/attendance/correct?pump=${shift.pump_id}&day=${group.day}`
											)}
											data-testid="fix-attendance"><Wrench size={15} /> Fix attendance</a
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
											{#if session.error_reason}<p class="half__note">
													{session.error_reason}
												</p>{/if}
											<AttendanceEvidenceButtons
												session={session.evidence}
												allowFlag={false}
												fraudCaseHref={(id) =>
													resolve('/plant-manager/approvals/fraud/[id]', { id })}
											/>
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
			{#if data.sessionPagination.totalPages > 1}
				<nav class="pager" aria-label="Session log pagination">
					{#if data.sessionPagination.page > 1}<a
							class="button button--secondary"
							href={sessionPageUrl(data.sessionPagination.page - 1)}>Previous</a
						>{:else}<span></span>{/if}
					<span>Page {data.sessionPagination.page} of {data.sessionPagination.totalPages}</span>
					{#if data.sessionPagination.page < data.sessionPagination.totalPages}<a
							class="button button--secondary"
							href={sessionPageUrl(data.sessionPagination.page + 1)}>Next</a
						>{/if}
				</nav>
			{/if}
		{:else}<EmptyState title="No sessions" description="Pump submissions will appear here." />{/if}
	</section>
</div>

<style>
	.eyebrow {
		margin: 0 0 var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
	}
	.supporting-text {
		margin: 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	/* One row: export, then the month and its button, bottoms aligned; wraps on a phone. */
	.header-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-3);
	}
	.headcount-form {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-3);
	}
	.header-actions .button {
		white-space: nowrap;
	}
	/* Session log: one heading per day, one numbered row per shift. Phone: the row stacks (who,
	   start, end); wide screens put start and end side by side for comparison. */
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
	.fix-link {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 2.75rem;
		margin-left: auto;
		color: var(--brand-teal);
		font-weight: 700;
		white-space: nowrap;
	}
	.half {
		display: grid;
		align-content: start;
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
	@media (min-width: 64rem) {
		.shift {
			grid-template-columns: minmax(12rem, 15rem) minmax(0, 1fr) minmax(0, 1fr);
			align-items: start;
			column-gap: var(--space-4);
		}
		.shift__who {
			flex-direction: column;
			flex-wrap: nowrap;
			align-items: flex-start;
		}
		.shift__tags {
			order: 0;
		}
		.fix-link {
			order: 1;
			margin-left: 0;
		}
		.half {
			padding-top: 0;
			padding-left: var(--space-4);
			border-top: 0;
			border-left: 1px solid var(--brand-mist);
		}
	}
	.compact-filter {
		grid-template-columns: repeat(2, minmax(11rem, 16rem)) auto;
		justify-content: start;
	}
	@media (max-width: 38rem) {
		/* One row: export, then the month and its button, bottoms aligned; wraps on a phone. */
		.header-actions {
			display: flex;
			flex-wrap: wrap;
			align-items: flex-end;
			gap: var(--space-3);
		}
		.headcount-form {
			display: flex;
			flex-wrap: wrap;
			align-items: flex-end;
			gap: var(--space-3);
		}
		.header-actions .button {
			white-space: nowrap;
		}
		.compact-filter {
			grid-template-columns: 1fr;
		}
	}
</style>
