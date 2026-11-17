<script lang="ts">
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/date';
	import { shiftTypeLabel } from '$lib/shiftLabels';
	import { PUMP_WORK_STATUS_LABELS } from '$lib/pumpWorkStatus';
	let { data, form } = $props();
</script>

<svelte:head><title>Assigned pumps | Face Attendance</title></svelte:head>
<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Plant manager</p>
			<h1>Pumps</h1>
			<p>
				The pumps Active or Idle today, with their latest submission and 30-day attendance. Light
				red: nobody counted today. Red edge: fraud today. If a pump operator cannot sign in, reset
				its password here.
			</p>
		</div>
	</header>
	{#if form?.credentials}
		<div class="credential-notice" role="status" data-testid="pump-temp-password">
			<strong>Password reset to the default. Give these to the pump operator.</strong>
			<span>They sign in with it and choose their own password straight away.</span>
			<code>{form.credentials.email}</code>
			<code>{form.credentials.password}</code>
		</div>
	{:else if form?.message}
		<p class="alert alert--error" role="alert">{form.message}</p>
	{/if}
	{#if data.pumps.length}<div class="table-wrap">
			<table class="data-table">
				<thead
					><tr
						><th>Pump</th><th>Status today</th><th>Plant</th><th>Area</th><th>Latest submission</th><th>Session</th><th
							>Photo</th
						><th>30-day attendance</th><th>Password</th></tr
					></thead
				><tbody
					>{#each data.pumps as pump (pump.id)}<tr
							class:row-none={pump.today_total === 0}
							class:row-fraud={pump.today_fraud > 0}
							data-testid="pm-pump-row"
							data-status={pump.work_status}
							data-attendance={pump.today_total === 0 ? 'none' : 'some'}
							><td
								><strong>{pump.pump_code}</strong>{#if pump.today_fraud}
									<span class="fraud-tag">{pump.today_fraud} fraud</span>{/if}</td
							><td
								><StatusBadge
									tone={pump.work_status === 'active' ? 'success' : 'pending'}
									label={PUMP_WORK_STATUS_LABELS[pump.work_status as 'active' | 'idle']}
								/></td
							><td>{pump.plant_name}</td><td
								>{pump.area_name}</td
							><td>{pump.submitted_at ? formatDate(pump.submitted_at) : 'No submissions'}</td><td
								>{pump.session_type ? shiftTypeLabel(pump.session_type) : '—'}</td
							><td
								><StatusBadge
									tone={pump.status === 'completed'
										? 'success'
										: pump.status === 'failed'
											? 'critical'
											: 'pending'}
									label={pump.status ?? 'Not started'}
								/></td
							><td>{pump.attendance_pct}%</td><td
								><form method="POST" action="?/resetPumpPassword">
									<input type="hidden" name="id" value={pump.id} /><button
										class="button button--secondary"
										type="submit"
										data-testid="reset-pump-password"
										onclick={(e) => {
											if (
												!confirm(
													`Reset the password of ${pump.pump_code}? The current password stops working at once.`
												)
											)
												e.preventDefault();
										}}
										title="Reset the password of {pump.login_email}">Reset password</button
									>
								</form></td
							></tr
						>{/each}</tbody
				>
			</table>
		</div>{:else}<EmptyState
			title="No Active or Idle pumps today"
			description="Set a pump Active or Idle on the Pump status page to see it here."
		/>{/if}
</div>

<style>
	.eyebrow {
		margin: 0 0 var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
	}
	.credential-notice {
		display: grid;
		gap: var(--space-2);
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
	.data-table .button {
		white-space: nowrap;
	}
	.fraud-tag {
		margin-left: var(--space-1);
		padding: 0.1rem 0.5rem;
		color: var(--surface-raised);
		font-size: var(--text-xs);
		font-weight: 700;
		white-space: nowrap;
		background: var(--alert);
		border-radius: 999px;
	}
</style>
