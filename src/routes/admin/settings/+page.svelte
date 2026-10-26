<script lang="ts">
	import { formatDate, formatDateTime } from '$lib/date';
	let { data, form } = $props();

	const sourceLabel = { admin: 'Set here', env: 'From server env', default: 'Default' } as const;
	const actionLabel: Record<string, string> = {
		update_settings: 'Changed settings',
		reset_settings: 'Reset settings',
		set_fraud_check: 'Switched fraud check',
		set_test_mode: 'Switched test mode',
		delete_session: 'Deleted a session',
		clear_pump_attendance: 'Cleared pump data'
	};

	function hoursAndMinutes(minutes: number) {
		const h = Math.floor(minutes / 60);
		const m = minutes % 60;
		return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
	}
</script>

<svelte:head><title>Settings | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Administration</p>
			<h1>Attendance settings</h1>
			<p>
				Timing rules for pairing shift start and shift end photos. Changes apply to the next
				submission.
			</p>
		</div>
	</header>

	{#if form?.message}
		<p class:alert--error={!form.success} class="alert" role="status">{form.message}</p>
	{/if}

	<section class="surface surface--padded section" aria-labelledby="timing-heading">
		<h2 id="timing-heading">Shift start and end timing</h2>
		<form method="POST" action="?/save" class="settings-form">
			<label class="field">
				<span>Minimum gap before shift end (minutes)</span>
				<input
					name="evening_min_gap_minutes"
					type="number"
					inputmode="numeric"
					min={data.limits.evening_min_gap_minutes.min}
					max={data.limits.evening_min_gap_minutes.max}
					step="1"
					required
					value={data.settings.evening_min_gap_minutes.value}
				/>
				<small>
					Now {hoursAndMinutes(data.settings.evening_min_gap_minutes.value)} ({sourceLabel[
						data.settings.evening_min_gap_minutes.source
					]}). Production rule: {hoursAndMinutes(data.defaults.evening_min_gap_minutes)}.
				</small>
			</label>
			<label class="field">
				<span>Auto-close open shift after (hours)</span>
				<input
					name="evening_pairing_window_hours"
					type="number"
					inputmode="numeric"
					min={data.limits.evening_pairing_window_hours.min}
					max={data.limits.evening_pairing_window_hours.max}
					step="1"
					required
					value={data.settings.evening_pairing_window_hours.value}
				/>
				<small>
					Now {data.settings.evening_pairing_window_hours.value} h ({sourceLabel[
						data.settings.evening_pairing_window_hours.source
					]}). After this, a shift with no end closes as start only and the next photo starts a new
					shift. The pump can also press End session once the gap has passed. Default: {data
						.defaults.evening_pairing_window_hours} h.
				</small>
			</label>
			<div class="settings-actions">
				<button type="submit" class="button button--primary">Save settings</button>
			</div>
		</form>
		<form method="POST" action="?/reset" class="reset-form">
			<button type="submit" class="button button--secondary">Reset to production defaults</button>
		</form>
		{#if data.settings.evening_min_gap_minutes.value < data.defaults.evening_min_gap_minutes}
			<p class="alert alert--error" role="status">
				The shift end gap is below the 9-hour production rule. Reset it before real attendance
				starts.
			</p>
		{/if}
	</section>

	<section
		class="surface surface--padded section"
		aria-labelledby="test-mode-heading"
		data-testid="test-mode-section"
	>
		<h2 id="test-mode-heading">Test mode</h2>
		<p class="supporting-text">
			For testing with the same few people at several pumps. While test mode is on, the cross-pump
			fraud check is off (the same person can be counted at two pumps) and fraud alert and location
			approval emails are not sent, only logged. Password reset emails still go out. Every admin
			page shows a red banner until it is turned off. Turn it off before real attendance starts.
		</p>
		<form
			method="POST"
			action="?/testMode"
			class="test-mode-form"
			onsubmit={(event) => {
				if (
					!data.testMode.on &&
					!confirm(
						'Turn test mode on? The fraud check stops and alert emails are not sent until it is turned off.'
					)
				)
					event.preventDefault();
			}}
		>
			<p>
				Test mode:
				<strong data-testid="test-mode-state">{data.testMode.on ? 'On' : 'Off'}</strong>
				{#if data.testMode.on && data.testMode.since}
					<span class="test-mode-since"
						>since {formatDateTime(data.testMode.since)}{#if data.testMode.by}
							by {data.testMode.by}{/if}</span
					>
				{/if}
			</p>
			<input type="hidden" name="on" value={data.testMode.on ? 'false' : 'true'} />
			<button
				type="submit"
				class={data.testMode.on ? 'button button--primary' : 'button button--secondary'}
			>
				{data.testMode.on ? 'Turn test mode off' : 'Turn test mode on'}
			</button>
		</form>
	</section>

	<section class="surface surface--padded section" aria-labelledby="audit-heading">
		<h2 id="audit-heading">Admin audit log</h2>
		<p class="supporting-text">Latest 25 setting changes and deletions.</p>
		{#if data.auditLog.length}
			<div class="table-wrap">
				<table class="data-table">
					<thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Details</th></tr></thead>
					<tbody>
						{#each data.auditLog as entry (entry.id)}
							<tr>
								<td>{formatDate(entry.created_at)}</td>
								<td>{entry.admin_email ?? '—'}</td>
								<td>{actionLabel[entry.action] ?? entry.action}</td>
								<td><code>{JSON.stringify(entry.details)}</code></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<p class="supporting-text">Nothing recorded yet.</p>
		{/if}
	</section>
</div>

<style>
	.settings-form {
		display: grid;
		gap: var(--space-4);
		max-width: 36rem;
	}
	.field {
		display: grid;
		gap: var(--space-1);
	}
	.field small {
		color: var(--ink-muted);
	}
	.test-mode-form {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
	}
	.test-mode-form p {
		margin: 0;
	}
	.reset-form {
	.test-mode-since {
		color: var(--ink-muted);
	}
		margin-top: var(--space-3);
	}
	code {
		font-size: var(--text-sm);
		word-break: break-word;
	}
</style>
