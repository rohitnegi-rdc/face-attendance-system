<script lang="ts">
	// The pumps Active or Idle today (load in +page.server.ts), one card per pump, phone first.
	// Tapping a card opens the pump's day (photos and who was counted). The plant and Area show only
	// when the manager has more than one; Reset password sits on each card for a locked-out phone.
	import { resolve } from '$app/paths';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import ShiftSplit from '$lib/components/ShiftSplit.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatHumanDateTime, formatHumanDay, todayStr } from '$lib/date';
	import { shiftTypeLabel } from '$lib/shiftLabels';
	import { PUMP_WORK_STATUS_LABELS } from '$lib/pumpWorkStatus';
	let { data, form } = $props();

	const where = (pump: any) =>
		[data.plantCount > 1 ? pump.plant_name : null, data.areaCount > 1 ? pump.area_name : null]
			.filter(Boolean)
			.join(' · ');
	const RESULT: Record<string, string> = {
		completed: 'counted',
		review: 'waiting for the pump to finish',
		pending: 'being read',
		processing: 'being read',
		failed: 'failed',
		fraud_detected: 'fraud'
	};
	function latest(pump: any) {
		if (!pump.submitted_at) return 'No photo sent yet';
		const what =
			pump.session_type === 'morning' &&
			pump.pairing_status === 'open' &&
			pump.status === 'completed'
				? 'shift still on'
				: (RESULT[pump.status] ?? pump.status);
		return `${shiftTypeLabel(pump.session_type)}, ${formatHumanDateTime(pump.submitted_at)}, ${what}`;
	}
	// Light red only for an Active pump with nobody counted: an Idle pump has no work today.
	const noneCounted = (pump: any) => pump.today_total === 0 && pump.work_status === 'active';
</script>

<svelte:head><title>Pumps | Face Attendance</title></svelte:head>
<div class="page">
	<header class="head">
		<h1>Pumps</h1>
		<p class="date">{formatHumanDay(todayStr())}</p>
		<p class="intro">
			The pumps Active or Idle today. Tap a pump to see its photos and who was counted.
		</p>
	</header>
	{#if form?.credentials}
		<div class="credential-notice" role="status" data-testid="pump-temp-password">
			<strong>Password reset to the default. Give these to the pump operator.</strong>
			<span>They sign in with it straight away.</span>
			<code>{form.credentials.email}</code>
			<code>{form.credentials.password}</code>
		</div>
	{:else if form?.message}
		<p class="alert alert--error" role="alert">{form.message}</p>
	{/if}

	{#if data.pumps.length}
		<ul class="pumps">
			{#each data.pumps as pump (pump.id)}
				<li
					class="pump"
					class:pump--none={noneCounted(pump)}
					class:pump--fraud={pump.today_fraud > 0}
					data-testid="pm-pump-row"
					data-status={pump.work_status}
					data-attendance={pump.today_total === 0 ? 'none' : 'some'}
				>
					<a
						class="pump__open"
						href={resolve('/plant-manager/pumps/[id]', { id: pump.id }) + '?from=pumps'}
					>
						<span class="pump__text">
							<span class="pump__name">
								<strong>{pump.pump_code}</strong>
								<StatusBadge
									tone={pump.work_status === 'active' ? 'success' : 'pending'}
									label={PUMP_WORK_STATUS_LABELS[pump.work_status as 'active' | 'idle']}
								/>
								{#if pump.today_fraud}<span class="fraud-tag">{pump.today_fraud} fraud</span>{/if}
							</span>
							{#if where(pump)}<small>{where(pump)}</small>{/if}
							{#if pump.site_name}<small>Site: {pump.site_name}</small>{/if}
							<span class="pump__today">
								{#if pump.today_total}
									<strong
										>{pump.today_total}
										{pump.today_total === 1 ? 'worker' : 'workers'} counted today</strong
									>
									<ShiftSplit
										full={pump.full_shift}
										startOnly={pump.start_only}
										endOnly={pump.end_only}
									/>
								{:else if pump.work_status === 'idle'}
									<span class="muted">Idle, no work</span>
								{:else}
									<strong class="alert-text">Nobody counted today</strong>
								{/if}
							</span>
							<span class="pump__meta">Latest photo: {latest(pump)}</span>
							<span class="pump__meta">Last 30 days: {pump.attendance_pct}% full shifts</span>
						</span>
						<ChevronRight size={18} />
					</a>
					<form class="pump__reset" method="POST" action="?/resetPumpPassword">
						<input type="hidden" name="id" value={pump.id} />
						<button
							class="reset"
							type="submit"
							data-testid="reset-pump-password"
							title="Reset the password of {pump.login_email}"
							onclick={(e) => {
								if (
									!confirm(
										`Reset the password of ${pump.pump_code}? The current password stops working at once.`
									)
								)
									e.preventDefault();
							}}><KeyRound size={15} /> Reset password</button
						>
					</form>
				</li>
			{/each}
		</ul>
	{:else}<EmptyState
			title="No Active or Idle pumps today"
			description="Set a pump Active or Idle on the Pump status page to see it here."
		/>{/if}
</div>

<style>
	.head {
		max-width: 48rem;
		margin-bottom: var(--space-4);
	}
	h1 {
		margin: 0;
	}
	.date {
		margin: var(--space-1) 0 0;
		color: var(--ink-muted);
	}
	.intro {
		margin: var(--space-2) 0 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.credential-notice {
		display: grid;
		gap: var(--space-2);
		max-width: 48rem;
		margin-bottom: var(--space-4);
		padding: var(--space-3);
		background: var(--surface-muted);
		border-left: 3px solid var(--brand-teal);
	}
	.credential-notice span {
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.credential-notice code {
		user-select: all;
		overflow-wrap: anywhere;
	}
	.pumps {
		max-width: 48rem;
		margin: 0;
		padding: 0;
		overflow: hidden;
		list-style: none;
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.pump + .pump {
		border-top: 1px solid var(--brand-mist);
	}
	/* Light red: an Active pump with nobody counted today. Fraud: the tint plus a solid red edge. */
	.pump--none,
	.pump--fraud {
		background: var(--alert-tint);
	}
	.pump--fraud {
		box-shadow: inset 4px 0 0 var(--alert);
	}
	.pump__open {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-3);
		color: var(--ink-default);
		text-decoration: none;
	}
	.pump__open > :global(svg) {
		flex: none;
		color: var(--ink-muted);
	}
	.pump__text {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
	}
	.pump__name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	.pump__name strong {
		color: var(--ink-strong);
		font-size: var(--text-lg);
	}
	small {
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}
	.pump__today {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-1);
		font-size: var(--text-sm);
	}
	.muted {
		color: var(--ink-muted);
	}
	.alert-text {
		color: var(--alert);
	}
	.pump__meta {
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}
	.pump__reset {
		padding: 0 var(--space-3) var(--space-3);
	}
	.reset {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: 2.5rem;
		padding: 0 var(--space-3);
		color: var(--ink-muted);
		font: inherit;
		font-size: var(--text-sm);
		font-weight: 600;
		background: none;
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
		cursor: pointer;
	}
	.reset:hover {
		color: var(--ink-strong);
		border-color: var(--brand-teal);
	}
	.fraud-tag {
		padding: 0.1rem 0.5rem;
		color: var(--surface-raised);
		font-size: var(--text-xs);
		font-weight: 700;
		white-space: nowrap;
		background: var(--alert);
		border-radius: 999px;
	}
</style>
