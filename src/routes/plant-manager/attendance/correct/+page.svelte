<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Eye from '@lucide/svelte/icons/eye';
	import Save from '@lucide/svelte/icons/save';
	import FacePeek from '$lib/components/FacePeek.svelte';
	import { formatDate } from '$lib/date';
	import { personShortLabel } from '$lib/personLabel';
	import { shiftTypeLabel } from '$lib/shiftLabels';
	import { showErrorToast } from '$lib/toast.svelte';

	let { data, form } = $props();

	// Unsaved ticks per worker; the reason and Save appear only for a worker whose ticks changed.
	let drafts = $state<Record<string, { start: boolean; end: boolean }>>({});
	const notFull = $derived(
		data.people.filter((p: any) => !(p.morning_matched && p.evening_matched)).length
	);
	function tick(person: any, half: 'start' | 'end', value: boolean) {
		const current = drafts[person.id] ?? {
			start: person.morning_matched,
			end: person.evening_matched
		};
		drafts[person.id] = { ...current, [half]: value };
	}
	function changed(person: any) {
		const draft = drafts[person.id];
		return Boolean(
			draft && (draft.start !== person.morning_matched || draft.end !== person.evening_matched)
		);
	}
</script>

<svelte:head><title>Fix attendance | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<a class="back-link" href={resolve('/plant-manager/attendance')}
				><ArrowLeft size={17} /> Attendance</a
			>
			<h1>Fix attendance</h1>
			<p>
				<strong>{data.pump.pump_code}</strong> · {formatDate(data.day)} · {data.pump.plant_name} ·
				{data.pump.vendor_name}
			</p>
		</div>
	</header>

	<p class="intro">
		Mark a worker present when the photo missed them, for example when the pump forgot the shift
		start and the end photo was taken as the start. Check the group photo first. Every change is
		saved with your name and reason.
	</p>

	<section class="photos" aria-label="Photos of this day">
		{#each data.sessions as session (session.id)}
			{#if session.has_photo}
				<a
					class="button button--secondary"
					href={resolve('/api/attendance/photo/[id]', { id: session.id })}
					target="_blank"
					rel="noreferrer"
					><Eye size={16} /> {shiftTypeLabel(session.session_type)} photo, {session.sent_time}</a
				>
			{/if}
		{:else}
			<p class="muted">The pump sent no photo this day, so attendance cannot be marked.</p>
		{/each}
	</section>

	{#if data.sessions.length}
		<p class="list-count">
			{data.people.length} workers at this pump · <strong>{notFull} not a full shift</strong>,
			listed first
		</p>
		<ul class="workers" data-testid="pm-correction-list">
			{#each data.people as person (person.id + person.morning_matched + person.evening_matched)}
				{@const label = personShortLabel(person.display_seq, person.is_operator, person.name)}
				{@const full = person.morning_matched && person.evening_matched}
				<li class="worker" class:worker--full={full}>
					<form
						method="POST"
						action="?/correct&pump={data.pump.id}&day={data.day}"
						use:enhance={() =>
							async ({ result, update }) => {
								if (result.type === 'error') showErrorToast();
								if (result.type === 'success') delete drafts[person.id];
								await update({ reset: false });
							}}
						data-testid="pm-correction-row"
					>
						<input type="hidden" name="person_id" value={person.id} />
						<input type="hidden" name="pump_id" value={data.pump.id} />
						<input type="hidden" name="day" value={data.day} />
						<div class="worker__who">
							<FacePeek url={resolve('/api/persons/[id]/face', { id: person.id })} {label} />
							<strong class:muted={!person.name}>{label}</strong>
							<span class="state" class:state--full={full}
								>{full
									? 'Full shift'
									: person.morning_matched
										? 'Start only'
										: person.evening_matched
											? 'End only'
											: 'Not in photo'}</span
							>
						</div>
						<div class="worker__checks">
							<label
								><input
									type="checkbox"
									name="morning_present"
									checked={drafts[person.id]?.start ?? person.morning_matched}
									onchange={(e) => tick(person, 'start', e.currentTarget.checked)}
								/> Shift start</label
							>
							<label
								><input
									type="checkbox"
									name="evening_present"
									checked={drafts[person.id]?.end ?? person.evening_matched}
									onchange={(e) => tick(person, 'end', e.currentTarget.checked)}
								/> Shift end</label
							>
						</div>
						{#if changed(person)}
							<div class="worker__save">
								<input
									name="reason"
									required
									minlength="5"
									maxlength="500"
									placeholder="Reason, e.g. pump missed the shift start"
									aria-label="Reason for {label}"
								/>
								<button class="button button--primary" type="submit"><Save size={16} /> Save</button
								>
							</div>
						{/if}
						{#if form?.personId === person.id}
							<p class={form?.error ? 'form-error' : 'form-ok'} role="status">
								{form?.error ?? form?.message}
							</p>
						{/if}
					</form>
				</li>
			{:else}
				<li class="muted">No workers at this pump yet.</li>
			{/each}
		</ul>
	{/if}

	{#if data.corrections.length}
		<section class="section">
			<h2>Changes this day</h2>
			<ul class="history">
				{#each data.corrections as correction (correction.id)}
					<li>
						<strong>{personShortLabel(correction.display_seq, false, correction.name)}</strong>
						<span
							>Start {correction.corrected_morning_matched ? 'present' : 'absent'}, end
							{correction.corrected_evening_matched ? 'present' : 'absent'}</span
						>
						<span class="muted">"{correction.reason}"</span>
						<small class="muted">{correction.corrected_by}, {correction.corrected_at}</small>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

<style>
	.intro {
		max-width: 46rem;
		margin: 0 0 var(--space-4);
		color: var(--ink-muted);
	}
	.photos {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-bottom: var(--space-4);
	}
	.muted {
		color: var(--ink-muted);
	}
	.list-count {
		margin: 0 0 var(--space-2);
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	/* Bounded: a pump can have dozens of workers; the page header and history stay in reach. */
	.workers {
		max-height: 70vh;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.workers,
	.history {
		display: grid;
		gap: var(--space-3);
		padding: 0;
		margin: 0;
		list-style: none;
	}
	.worker form {
		display: grid;
		grid-template-columns: minmax(12rem, 1.2fr) auto minmax(16rem, 1.5fr);
		gap: var(--space-2) var(--space-3);
		align-items: center;
		padding: var(--space-3);
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-left: 4px solid #b45309;
		border-radius: var(--radius-md);
	}
	.worker--full form {
		border-left-color: var(--brand-teal);
	}
	.worker__who {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}
	.state {
		padding: 0.1rem 0.45rem;
		color: #92400e;
		font-size: var(--text-xs);
		font-weight: 700;
		background: #fffbeb;
		border-radius: 999px;
	}
	.state--full {
		color: #047857;
		background: #ecfdf5;
	}
	.worker__checks {
		display: flex;
		gap: var(--space-3);
		white-space: nowrap;
	}
	.worker__checks label {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 2.75rem;
	}
	.worker__save {
		display: flex;
		gap: var(--space-2);
	}
	.worker__save input {
		flex: 1;
		min-width: 0;
	}
	.form-error,
	.form-ok {
		grid-column: 1 / -1;
		margin: 0;
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.form-error {
		color: var(--alert);
	}
	.form-ok {
		color: var(--brand-teal);
	}
	.history li {
		display: grid;
		gap: 0.15rem;
		padding: var(--space-3);
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	@media (max-width: 52rem) {
		.worker form {
			grid-template-columns: 1fr;
		}
	}
</style>
