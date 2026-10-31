<script lang="ts">
	import { formatDate, formatDateTime } from '$lib/date';
	let { data, form } = $props();
	// Ticked areas first, so the ones that get the email are seen without scrolling.
	const pickOrder = $derived(
		[...data.digestAreas].sort((a, b) => Number(b.digest_enabled) - Number(a.digest_enabled))
	);
	// "Mon, 2 Nov 2026" for a YYYY-MM-DD day.
	function humanDay(value: string) {
		return new Intl.DateTimeFormat('en-GB', {
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			timeZone: 'UTC'
		})
			.format(new Date(`${value}T00:00:00Z`))
			.replace(/^(\w+) /, '$1, ')
			.replace('Sept', 'Sep');
	}
	const nextDay = (value: string) =>
		new Date(Date.parse(`${value}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
	const enabledAreas = $derived(
		data.digestAreas.filter((area) => area.digest_enabled).map((area) => area.name)
	);

	const sourceLabel = { admin: 'Set here', env: 'From server env', default: 'Default' } as const;
	const actionLabel: Record<string, string> = {
		update_settings: 'Changed settings',
		reset_settings: 'Reset settings',
		set_fraud_check: 'Switched fraud check',
		set_test_mode: 'Switched test mode',
		set_approval_email: 'Switched location approval emails',
		update_digest_cc: 'Changed attendance email copies',
		update_digest_areas: 'Changed attendance email areas',
		delete_session: 'Deleted a session',
		clear_pump_attendance: 'Cleared pump data',
		clear_test_attendance: 'Cleared test records'
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

	{#if form?.message && form?.formKind !== 'digest'}
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
		aria-labelledby="digest-heading"
		data-testid="digest-cc-section"
	>
		<h2 id="digest-heading">Daily attendance email</h2>
		<p class="supporting-text">
			Every morning at 9 am, one email per ticked area with the attendance of the day before: full
			shift, start only and end only for every Active and Idle pump (set at Pump status), a pump
			with no one counted in red. It goes to the admins and the area's monitors, with a copy to
			everyone on the CC list below and no one else.
		</p>
		{#if data.digestFirstDay}
			<p class="supporting-text" data-testid="digest-first">
				First email: <strong>{humanDay(nextDay(data.digestFirstDay))}, 9 am</strong>, about
				{humanDay(data.digestFirstDay)}. No email is sent for an earlier day.
			</p>
		{/if}
		{#if form?.formKind === 'digest' && form?.message}
			<p class:alert--error={!form.success} class="alert" role="status">{form.message}</p>
		{/if}
		<form method="POST" action="?/digestAreas" class="digest-form" data-testid="digest-areas">
			<fieldset class="area-picks">
				<legend>Send for these areas</legend>
				<div class="area-list">
					{#each pickOrder as area (area.id)}
						<label class="area-pick"
							><input type="checkbox" name="area" value={area.id} checked={area.digest_enabled} />
							{area.name}</label
						>
					{/each}
				</div>
			</fieldset>
			<p class="supporting-text" data-testid="digest-areas-now">
				{#if enabledAreas.length}Goes out now for: <strong>{enabledAreas.join(', ')}</strong
					>.{:else}<strong>No area is ticked, so no attendance email goes out.</strong>{/if}
			</p>
			<div class="settings-actions">
				<button type="submit" class="button button--primary">Save areas</button>
			</div>
		</form>
		<div class="cc-block" data-testid="digest-cc">
			<h3 class="cc-title">CC ({data.digestCc.length})</h3>
			{#if form?.formKind === 'digest-cc' && form?.message}
				<p class:alert--error={!form.success} class="alert" role="status">{form.message}</p>
			{/if}
			{#if data.digestCc.length}
				<ul class="cc-list">
					{#each data.digestCc as email (email)}
						<li>
							<span class="cc-email">{email}</span>
							<form method="POST" action="?/removeDigestCc">
								<input type="hidden" name="email" value={email} />
								<button
									type="submit"
									class="button button--secondary cc-remove"
									aria-label="Remove {email}">Remove</button
								>
							</form>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="supporting-text"><strong>No one is copied.</strong></p>
			{/if}
			<form method="POST" action="?/addDigestCc" class="cc-add">
				<label class="field">
					<span>Add to CC (several at once: put a comma between them)</span>
					<input
						name="cc"
						type="text"
						inputmode="email"
						autocomplete="off"
						placeholder="name@rdc.in"
						data-testid="digest-cc-add"
					/>
				</label>
				<button type="submit" class="button button--primary">Add</button>
			</form>
		</div>
	</section>

	<section
		class="surface surface--padded section"
		aria-labelledby="approval-email-heading"
		data-testid="approval-email-section"
	>
		<h2 id="approval-email-heading">Location approval email</h2>
		<p class="supporting-text">
			When a shift start photo is sent too far from the pump, the shift waits for the plant
			manager's approval on their Approvals page. This switch only decides whether they also get an
			email for it. The approval works either way.
		</p>
		{#if form?.formKind === 'approval-email' && form?.message}
			<p class:alert--error={!form.success} class="alert" role="status">{form.message}</p>
		{/if}
		<p class="supporting-text" data-testid="approval-email-state">
			Approval emails are <strong>{data.approvalEmailOn ? 'on' : 'off'}</strong>.
		</p>
		<form method="POST" action="?/approvalEmail" class="settings-actions">
			<input type="hidden" name="on" value={data.approvalEmailOn ? 'false' : 'true'} />
			<button type="submit" class="button button--secondary">
				{data.approvalEmailOn ? 'Turn approval emails off' : 'Turn approval emails on'}
			</button>
		</form>
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
	.area-picks {
		margin: 0;
		padding: 0;
		border: 0;
	}
	/* Every area fits in a short scroll box; the ticked ones come first. */
	.area-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
		column-gap: var(--space-3);
		max-height: 15rem;
		overflow-y: auto;
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.area-picks legend {
		margin-bottom: var(--space-2);
		font-weight: 600;
	}
	.area-pick {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		min-height: 2.75rem;
		overflow-wrap: anywhere;
	}
	.cc-block {
		display: grid;
		gap: var(--space-3);
		max-width: 36rem;
	}
	.cc-title {
		margin: 0;
		font-size: 1rem;
	}
	.cc-list {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.cc-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3);
	}
	.cc-list li + li {
		border-top: 1px solid var(--brand-mist);
	}
	.cc-email {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.cc-remove {
		flex-shrink: 0;
	}
	.cc-add {
		display: flex;
		align-items: flex-end;
		gap: var(--space-2);
	}
	.cc-add .field {
		flex: 1;
		min-width: 0;
	}
	.area-pick input {
		flex-shrink: 0;
		width: 1.25rem;
		height: 1.25rem;
	}
	.settings-form,
	.digest-form {
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
	.test-mode-since {
		color: var(--ink-muted);
	}
	.reset-form {
		margin-top: var(--space-3);
	}
	code {
		font-size: var(--text-sm);
		word-break: break-word;
	}
</style>
