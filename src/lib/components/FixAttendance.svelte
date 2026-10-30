<script lang="ts">
	// Fix attendance for one pump and day, the same page for the admin and the plant manager or
	// monitor (load and actions in fixAttendance.ts). Phone first: "Same people?" when the camera
	// split the crew, both photos whole, then one row per worker, not a full shift first. A row's
	// ticks get a reason and Save only once changed; Rename, Wrong worker? and Counted twice? open
	// under the row.
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Shuffle from '@lucide/svelte/icons/shuffle';
	import Save from '@lucide/svelte/icons/save';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import UserMinus from '@lucide/svelte/icons/user-minus';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import type { SubmitFunction } from '@sveltejs/kit';
	import SamePeople from '$lib/components/SamePeople.svelte';
	import { formatDate, formatDateTime, formatTime } from '$lib/date';
	import { personShortLabel } from '$lib/personLabel';
	import { shiftTypeLabel } from '$lib/shiftLabels';
	import { showErrorToast } from '$lib/toast.svelte';

	let { data, form, backHref }: { data: any; form: any; backHref: string } = $props();

	const STATUS: Record<string, string> = {
		completed: 'Counted',
		review: 'Waiting for pump to complete',
		pending: 'Processing',
		processing: 'Processing',
		failed: 'Failed',
		fraud_detected: 'Fraud'
	};
	// Photos a worker can be counted for (marked twice, or added as missed).
	const counted = $derived(
		data.sessions.filter((s: any) => s.status === 'completed' || s.status === 'review')
	);
	const notFull = $derived(
		data.people.filter((p: any) => !(p.morning_matched && p.evening_matched)).length
	);
	const label = (p: { display_seq: number; is_operator?: boolean; name: string | null }) =>
		personShortLabel(p.display_seq, p.is_operator ?? false, p.name);

	// Unsaved ticks per worker; the reason and Save appear only for a worker whose ticks changed.
	let drafts = $state<Record<string, { start: boolean; end: boolean }>>({});
	type Tool = 'rename' | 'move' | 'twice';
	// The one tool open under a worker: Rename, Wrong worker? or Counted twice?
	let open = $state<Record<string, Tool | undefined>>({});
	// Wrong worker?: the photo whose face moves, and the worker it goes to ('' = a new worker).
	let moveFrom = $state<Record<string, string>>({});
	let moveTo = $state<Record<string, string>>({});
	// Workers who can take the face: the others of the pump not already in that photo.
	const moveTargets = (person: any, sessionId: string) =>
		data.people.filter(
			(other: any) =>
				other.id !== person.id && !other.faces.some((f: any) => f.sessionId === sessionId)
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
	function toggle(person: any, tool: Tool) {
		open[person.id] = open[person.id] === tool ? undefined : tool;
		if (tool === 'move' && !moveFrom[person.id]) moveFrom[person.id] = person.faces[0]?.sessionId;
	}
	// Marked counted twice for this half: the other worker kept the count.
	const twiceFor = (personId: string, half: string) =>
		data.duplicates.find(
			(d: any) => !d.reversed_at && d.duplicate_person_id === personId && d.session_type === half
		);
	function dayState(person: any) {
		if (person.morning_matched && person.evening_matched) return 'Full shift';
		if (person.morning_matched) return 'Start only';
		if (person.evening_matched) return 'End only';
		return 'Not in photo';
	}

	// One worker's form: stays on the page, closes the tool and the draft once saved.
	const rowEnhance =
		(personId: string): SubmitFunction =>
		() =>
		async ({ result, update }) => {
			if (result.type === 'error') showErrorToast();
			if (result.type === 'success') {
				delete drafts[personId];
				open[personId] = undefined;
			}
			await update({ reset: false });
		};
	const pageEnhance: SubmitFunction =
		() =>
		async ({ result, update }) => {
			if (result.type === 'error') showErrorToast();
			await update();
		};

	// Corrections and counted-twice decisions in one list, newest first.
	const history = $derived(
		[
			...data.corrections.map((c: any) => ({
				id: c.id,
				at: c.corrected_at,
				who: label(c),
				what: `Start ${c.corrected_morning_matched ? 'present' : 'absent'}, end ${c.corrected_evening_matched ? 'present' : 'absent'}`,
				reason: c.reason,
				by: c.corrected_by,
				undone: false
			})),
			...data.duplicates.map((d: any) => ({
				id: d.id,
				at: d.resolved_at,
				who: label({ display_seq: d.duplicate_seq, name: d.duplicate_name }),
				what: `${shiftTypeLabel(d.session_type)}: counted twice, kept as ${label({ display_seq: d.kept_seq, name: d.kept_name })}`,
				reason: d.reason,
				by: d.resolved_by,
				undone: Boolean(d.reversed_at)
			}))
		].sort((a, b) => String(b.at).localeCompare(String(a.at)))
	);
</script>

<svelte:head><title>Fix attendance | Face Attendance</title></svelte:head>

<div class="page fix-page">
	<header class="page-header">
		<div class="page-header__copy">
			<a class="back-link" href={backHref}><ArrowLeft size={17} /> Attendance</a>
			<h1>Fix attendance</h1>
			<p>
				<strong>{data.pump.pump_code}</strong> · {formatDate(data.day)} · {data.pump.plant_name} ·
				{data.pump.vendor_name}
			</p>
		</div>
	</header>

	{#if form?.message && !form?.personId}<p class="notice notice--success" role="status">
			{form.message}
		</p>{/if}
	{#if form?.error && !form?.personId}<p class="notice notice--error" role="alert">
			{form.error}
		</p>{/if}

	{#if data.same}
		<SamePeople same={data.same} action="?/samePeople&pump={data.pump.id}&day={data.day}" />
	{/if}

	<section class="block" aria-labelledby="photos-title">
		<h2 id="photos-title">Photos</h2>
		<p class="hint">Check the worker in the photo before you change anything.</p>
		<div class="photos">
			{#each ['morning', 'evening'] as half (half)}
				{@const session = data.sessions.findLast((s: any) => s.session_type === half)}
				<figure class="photo">
					<figcaption>
						<strong>{shiftTypeLabel(half)}</strong>
						{#if session}<span
								>{formatTime(session.submitted_at)} · {STATUS[session.status] ??
									session.status}</span
							>{:else}<span>No photo</span>{/if}
					</figcaption>
					{#if session?.has_photo}
						<a
							class="photo__frame"
							href={resolve('/api/attendance/photo/[id]', { id: session.id })}
							target="_blank"
							rel="noreferrer"
						>
							<img
								src={resolve('/api/attendance/photo/[id]', { id: session.id })}
								alt="{shiftTypeLabel(half)} group photo"
							/>
						</a>
					{:else}
						<div class="photo__empty">
							The pump sent no {shiftTypeLabel(half).toLowerCase()} photo
						</div>
					{/if}
				</figure>
			{/each}
		</div>
	</section>

	<section class="block" aria-labelledby="workers-title">
		<h2 id="workers-title">Workers</h2>
		{#if counted.length}
			<p class="hint">
				{data.people.length} at this pump · <strong>{notFull} not a full shift</strong>, listed
				first. Tick who was there; every change is saved with your name and reason.
			</p>
		{:else}
			<p class="hint">The pump sent no counted photo this day, so attendance cannot be marked.</p>
		{/if}
		<ul class="workers" data-testid="fix-workers">
			{#each data.people as person (person.id + person.morning_matched + person.evening_matched)}
				{@const name = label(person)}
				{@const full = person.morning_matched && person.evening_matched}
				{@const twiceStart = twiceFor(person.id, 'morning')}
				{@const twiceEnd = twiceFor(person.id, 'evening')}
				<li class="worker" class:worker--full={full} data-testid="fix-worker">
					<div class="worker__who">
						<span class="face">
							{#if person.has_face}<img
									src={resolve('/api/persons/[id]/face', { id: person.id })}
									alt=""
									loading="lazy"
								/>{/if}
						</span>
						<span class="worker__name">
							<strong class:muted={!person.name}>{name}</strong>
							<span class="state" class:state--full={full}>{dayState(person)}</span>
						</span>
					</div>

					<form
						class="worker__ticks"
						method="POST"
						action="?/correct&pump={data.pump.id}&day={data.day}"
						use:enhance={rowEnhance(person.id)}
						data-testid="fix-ticks"
					>
						<input type="hidden" name="person_id" value={person.id} />
						<input type="hidden" name="pump_id" value={data.pump.id} />
						<input type="hidden" name="day" value={data.day} />
						<div class="checks">
							{#if !twiceStart}<label class="check"
									><input
										type="checkbox"
										name="morning_present"
										checked={drafts[person.id]?.start ?? person.morning_matched}
										disabled={!counted.length}
										onchange={(e) => tick(person, 'start', e.currentTarget.checked)}
									/> Shift start</label
								>{/if}
							{#if !twiceEnd}<label class="check"
									><input
										type="checkbox"
										name="evening_present"
										checked={drafts[person.id]?.end ?? person.evening_matched}
										disabled={!counted.length}
										onchange={(e) => tick(person, 'end', e.currentTarget.checked)}
									/> Shift end</label
								>{/if}
						</div>
						{#if changed(person)}
							<div class="save-line">
								<input
									name="reason"
									required
									minlength="5"
									maxlength="500"
									placeholder="Reason, e.g. pump missed the shift start"
									aria-label="Reason for {name}"
								/>
								<button class="button button--primary" type="submit"><Save size={16} /> Save</button
								>
							</div>
						{/if}
					</form>

					{#each [twiceStart, twiceEnd].filter(Boolean) as twice (twice.id)}
						<form
							class="twice-note"
							method="POST"
							action="?/undoDuplicate&pump={data.pump.id}&day={data.day}"
							use:enhance={rowEnhance(person.id)}
						>
							<input type="hidden" name="person_id" value={person.id} />
							<input type="hidden" name="resolution_id" value={twice.id} />
							<span
								>{shiftTypeLabel(twice.session_type)}: counted twice, kept as
								<strong>{label({ display_seq: twice.kept_seq, name: twice.kept_name })}</strong
								></span
							>
							<button class="tool" type="submit"><Undo2 size={15} /> Undo</button>
						</form>
					{/each}

					<div class="worker__tools">
						<button
							class="tool"
							type="button"
							aria-expanded={open[person.id] === 'rename'}
							onclick={() => toggle(person, 'rename')}
							data-testid="fix-rename-open"><Pencil size={15} /> Rename</button
						>
						{#if person.faces.length}<button
								class="tool"
								type="button"
								aria-expanded={open[person.id] === 'move'}
								onclick={() => toggle(person, 'move')}
								data-testid="fix-move-open"><Shuffle size={15} /> Wrong worker?</button
							>{/if}
						{#if counted.length && data.people.length > 1}<button
								class="tool"
								type="button"
								aria-expanded={open[person.id] === 'twice'}
								onclick={() => toggle(person, 'twice')}
								><UserMinus size={15} /> Counted twice?</button
							>{/if}
					</div>

					{#if open[person.id] === 'rename'}
						<form
							class="panel"
							method="POST"
							action="?/rename&pump={data.pump.id}&day={data.day}"
							use:enhance={rowEnhance(person.id)}
							data-testid="fix-rename"
						>
							<input type="hidden" name="person_id" value={person.id} />
							<label class="field"
								><span>Name of worker #{person.display_seq}</span>
								<!-- svelte-ignore a11y_autofocus -->
								<input
									name="name"
									value={person.name ?? ''}
									maxlength="60"
									required
									autocomplete="off"
									autofocus
								/></label
							>
							<button class="button button--primary" type="submit">Save name</button>
						</form>
					{:else if open[person.id] === 'move'}
						{@const fromId = moveFrom[person.id] ?? person.faces[0]?.sessionId}
						<form
							class="panel"
							method="POST"
							action="?/moveFace&pump={data.pump.id}&day={data.day}"
							use:enhance={rowEnhance(person.id)}
							data-testid="fix-move"
						>
							<p class="panel__hint">
								The camera counted someone else as {name}. The face goes to the right worker, who is
								counted for that photo instead of {name}.
							</p>
							<input type="hidden" name="person_id" value={person.id} />
							<fieldset class="move-faces">
								<legend>Which face is wrong</legend>
								{#each person.faces as face (face.evidenceId)}
									<label class="move-face">
										<input
											type="radio"
											name="session_id"
											value={face.sessionId}
											checked={face.sessionId === fromId}
											onchange={() => {
												moveFrom[person.id] = face.sessionId;
												moveTo[person.id] = '';
											}}
										/>
										<span class="face">
											{#if face.hasCrop}<img
													src={resolve('/api/attendance/face/[id]', { id: face.evidenceId })}
													alt="{name} in the {shiftTypeLabel(face.sessionType).toLowerCase()} photo"
													loading="lazy"
												/>{/if}
										</span>
										<span>{shiftTypeLabel(face.sessionType)}</span>
									</label>
								{/each}
							</fieldset>
							<label class="field"
								><span>This face is</span><select
									name="to_person_id"
									value={moveTo[person.id] ?? ''}
									onchange={(e) => (moveTo[person.id] = e.currentTarget.value)}
									data-testid="fix-move-to"
									><option value="">A new worker</option
									>{#each moveTargets(person, fromId) as other (other.id)}<option value={other.id}
											>{label(other)}</option
										>{/each}</select
								></label
							>
							{#if !moveTo[person.id]}
								<label class="field"
									><span>New worker's name</span><input
										name="name"
										maxlength="60"
										required
										autocomplete="off"
									/></label
								>
							{/if}
							<button class="button button--primary" type="submit">Move the face</button>
						</form>
					{:else if open[person.id] === 'twice'}
						<form
							class="panel"
							method="POST"
							action="?/markDuplicate&pump={data.pump.id}&day={data.day}"
							use:enhance={rowEnhance(person.id)}
						>
							<p class="panel__hint">
								The camera saw one person as two workers. {name} keeps the count; the other one's count
								for that photo is removed. You can undo it.
							</p>
							<input type="hidden" name="person_id" value={person.id} />
							<input type="hidden" name="pump_id" value={data.pump.id} />
							<input type="hidden" name="day" value={data.day} />
							<label class="field"
								><span>The same person as</span><select name="duplicate_person_id" required
									><option value="">Pick a worker</option
									>{#each data.people.filter((other: any) => other.id !== person.id) as other (other.id)}<option
											value={other.id}>{label(other)}</option
										>{/each}</select
								></label
							>
							<label class="field"
								><span>In which photo</span><select name="session_type"
									>{#each counted as session (session.id)}<option value={session.session_type}
											>{shiftTypeLabel(session.session_type)}</option
										>{/each}</select
								></label
							>
							<label class="field"
								><span>How did you check?</span><input
									name="duplicate_reason"
									required
									minlength="5"
									maxlength="500"
									placeholder="e.g. same face twice in the start photo"
								/></label
							>
							<button class="button button--primary" type="submit">Remove the extra count</button>
						</form>
					{/if}

					{#if form?.personId === person.id}
						<p class={form?.error ? 'row-error' : 'row-ok'} role="status">
							{form?.error ?? form?.message}
						</p>
					{/if}
				</li>
			{:else}
				<li class="muted">No workers at this pump yet.</li>
			{/each}
		</ul>
	</section>

	{#if counted.length}
		<section class="block" aria-labelledby="missed-title">
			<h2 id="missed-title">A worker the camera missed</h2>
			<p class="hint">
				For someone in the photo who is not in the list above. They are added to {data.pump
					.pump_code} and counted for the photo you pick.
			</p>
			<form
				class="missed"
				method="POST"
				action="?/addMissedWorker&pump={data.pump.id}&day={data.day}"
				use:enhance={pageEnhance}
			>
				<label class="field"
					><span>Name</span><input name="name" maxlength="60" required autocomplete="off" /></label
				>
				<label class="field"
					><span>Photo</span><select name="session_id" required
						>{#each counted as session (session.id)}<option value={session.id}
								>{shiftTypeLabel(session.session_type)}</option
							>{/each}</select
					></label
				>
				<button class="button button--primary" type="submit"
					><UserPlus size={16} /> Add and mark present</button
				>
			</form>
		</section>
	{/if}

	{#if history.length}
		<section class="block" aria-labelledby="history-title">
			<h2 id="history-title">Changes this day</h2>
			<ul class="history">
				{#each history as item (item.id)}
					<li class:undone={item.undone}>
						<strong>{item.who}</strong>
						<span>{item.what}{item.undone ? ' (undone)' : ''}</span>
						<span class="muted">"{item.reason}"</span>
						<small class="muted">{item.by}, {formatDateTime(item.at)}</small>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

<style>
	.fix-page {
		--content-max: 72rem;
	}
	.back-link {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		margin-bottom: var(--space-2);
	}
	.notice {
		margin: 0 0 var(--space-4);
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.notice--success {
		background: var(--success-soft);
	}
	.notice--error {
		background: var(--danger-soft);
	}
	.block {
		margin-top: var(--space-6);
	}
	.block h2 {
		margin: 0 0 var(--space-1);
		font-size: var(--text-lg);
	}
	.hint {
		max-width: 46rem;
		margin: 0 0 var(--space-3);
		color: var(--ink-muted);
	}
	.muted {
		color: var(--ink-muted);
	}

	/* The whole photo, never cropped: every face in it can be checked. */
	.photos {
		display: grid;
		gap: var(--space-3);
	}
	.photo {
		margin: 0;
		overflow: hidden;
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.photo figcaption {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--space-1) var(--space-2);
		padding: var(--space-2) var(--space-3);
		background: var(--surface-muted);
	}
	.photo figcaption span {
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.photo__frame {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 17rem;
		background: #1f2937;
	}
	.photo__frame img {
		display: block;
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
	}
	.photo__empty {
		display: grid;
		min-height: 8rem;
		padding: var(--space-3);
		place-items: center;
		color: var(--ink-muted);
		text-align: center;
	}

	/* Bounded: a pump can have dozens of workers; the photos and history stay in reach. */
	.workers {
		display: grid;
		gap: var(--space-2);
		max-height: 75vh;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		list-style: none;
	}
	.worker {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3);
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.worker--full {
		background: var(--surface-subtle);
	}
	.worker__who {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
	}
	.face {
		display: block;
		flex: none;
		width: 3.25rem;
		height: 3.25rem;
		overflow: hidden;
		background: var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.face img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.worker__name {
		display: grid;
		justify-items: start;
		gap: 0.2rem;
		min-width: 0;
	}
	.worker__name strong {
		overflow-wrap: anywhere;
	}
	.state {
		padding: 0.1rem 0.5rem;
		color: #92400e;
		font-size: var(--text-xs);
		font-weight: 700;
		background: #fef3c7;
		border-radius: 999px;
	}
	.state--full {
		color: #047857;
		background: #ecfdf5;
	}
	.worker__ticks {
		display: grid;
		gap: var(--space-2);
	}
	.checks {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.check {
		display: inline-flex;
		flex: 1 1 8rem;
		align-items: center;
		gap: var(--space-2);
		min-height: 2.75rem;
		padding: 0 var(--space-3);
		font-weight: 600;
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
		cursor: pointer;
	}
	.check input {
		width: 1.15rem;
		height: 1.15rem;
	}
	.save-line {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.save-line input {
		flex: 1 1 12rem;
		min-width: 0;
	}
	.twice-note {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-1) var(--space-2);
		padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3);
		font-size: var(--text-sm);
		background: var(--danger-soft);
		border-radius: var(--radius-md);
	}
	.worker__tools {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-3);
	}
	.tool {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 2.75rem;
		padding: 0 var(--space-1);
		color: var(--brand-teal);
		font: inherit;
		font-size: var(--text-sm);
		font-weight: 700;
		background: transparent;
		border: 0;
		cursor: pointer;
	}
	.tool[aria-expanded='true'] {
		text-decoration: underline;
		text-underline-offset: 0.25em;
	}
	.panel {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3);
		background: var(--surface-subtle);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.move-faces {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		border: 0;
	}
	.move-faces legend {
		margin-bottom: var(--space-1);
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.move-face {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-2);
		font-size: var(--text-sm);
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
		cursor: pointer;
	}
	.move-face input {
		flex: none;
		width: 1.125rem;
		height: 1.125rem;
		min-height: 0;
		margin: 0;
	}
	.move-face:has(input:checked) {
		border-color: var(--brand-teal);
		box-shadow: 0 0 0 1px var(--brand-teal);
	}
	.panel__hint {
		margin: 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.panel .button {
		justify-self: start;
	}
	.field {
		display: grid;
		gap: var(--space-1);
	}
	.field span {
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.row-ok,
	.row-error {
		margin: 0;
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.row-ok {
		color: var(--brand-teal);
	}
	.row-error {
		color: var(--alert);
	}
	.missed {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-3);
	}
	.missed .field {
		flex: 1 1 12rem;
	}
	.history {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.history li {
		display: grid;
		gap: 0.15rem;
		padding: var(--space-3);
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.history .undone {
		opacity: 0.7;
	}

	/* Wide: photos side by side; each worker on one line (who, ticks, tools), panels below. */
	@media (min-width: 48rem) {
		.photos {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.photo__frame {
			height: 22rem;
		}
		.worker {
			grid-template-columns: minmax(14rem, 1fr) minmax(16rem, 1.4fr) auto;
			align-items: start;
			column-gap: var(--space-4);
		}
		.worker > :not(.worker__who, .worker__ticks, .worker__tools) {
			grid-column: 1 / -1;
		}
		.worker__tools {
			flex-direction: column;
			align-items: flex-end;
			gap: 0;
		}
		.panel {
			grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
			align-items: end;
		}
		.panel__hint {
			grid-column: 1 / -1;
		}
	}
</style>
