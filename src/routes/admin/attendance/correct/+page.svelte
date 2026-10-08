<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Save from '@lucide/svelte/icons/save';
	import UserMinus from '@lucide/svelte/icons/user-minus';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from './$types';
	import { formatDate } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';

	let { data, form } = $props();
	let availableSessions = $derived(new Set(data.sessions.map((session: any) => session.session_type)));
	const activeDuplicate = (personId: string, sessionType: string) => data.duplicateResolutions.find((item: any) => !item.reversed_at && item.duplicate_person_id === personId && item.session_type === sessionType);
	const enhanceInPlace: SubmitFunction = () => async ({ update }) => {
		await update({ reset: false, invalidateAll: true });
	};
</script>

<svelte:head><title>Correct attendance | Face Attendance</title></svelte:head>

<div class="page correction-page">
	<header class="page-header">
		<div class="page-header__copy">
			<a class="back-link" href={resolve(`/admin/attendance?day=${data.day}`)}>
				<ArrowLeft size={17} /> Attendance
			</a>
			<h1>Correct attendance</h1>
			<p>
				{data.pump.pump_code} · {formatDate(data.day)} · {data.pump.plant_name}, {data.pump.area_name}
			</p>
		</div>
	</header>

	{#if form?.message}<p class="notice notice--success" role="status">{form.message}</p>{/if}
	{#if form?.error}<p class="notice notice--error" role="alert">{form.error}</p>{/if}

	<section class="section" aria-labelledby="source-photos-heading">
		<div class="section-header">
			<div>
				<h2 id="source-photos-heading">Source photos</h2>
				<p class="supporting-text">Verify the worker in the original evidence before correcting.</p>
			</div>
		</div>
		<div class="evidence-grid">
			{#each ['morning', 'evening'] as sessionType}
				{@const session = data.sessions.find((item: any) => item.session_type === sessionType)}
				<figure class="evidence-item">
					<figcaption>
						<strong>{sessionType === 'morning' ? 'Morning' : 'Evening'}</strong>
						<span>{session ? session.status : 'Not submitted'}</span>
					</figcaption>
					{#if session?.has_photo}
						<a href={resolve(`/api/attendance/photo/${session.id}`)} target="_blank" rel="noreferrer">
							<img src={resolve(`/api/attendance/photo/${session.id}`)} alt={`${sessionType} group attendance evidence`} />
						</a>
					{:else}
						<div class="evidence-empty">No photo available</div>
					{/if}
				</figure>
			{/each}
		</div>
	</section>

	<section class="section" aria-labelledby="roster-heading">
		<div class="section-header">
			<div>
				<h2 id="roster-heading">Worker roster</h2>
				<p class="supporting-text">Only change attendance after confirming the worker in the photo.</p>
			</div>
		</div>
		<div class="correction-roster" data-testid="attendance-correction-roster">
			{#each data.people as person (person.id + ':' + person.morning_matched + ':' + person.evening_matched + ':' + (activeDuplicate(person.id, 'morning')?.id ?? '') + ':' + (activeDuplicate(person.id, 'evening')?.id ?? ''))}
				{@const morningDuplicate = activeDuplicate(person.id, 'morning')}
				{@const eveningDuplicate = activeDuplicate(person.id, 'evening')}
				<form method="POST" use:enhance={enhanceInPlace} action={`?/correct&pump=${data.pump.id}&day=${data.day}`} class="correction-row" data-testid="attendance-correction-row">
					<input type="hidden" name="person_id" value={person.id} />
					<input type="hidden" name="kept_person_id" value={person.id} />
					<input type="hidden" name="pump_id" value={data.pump.id} />
					<input type="hidden" name="day" value={data.day} />
					<div class="worker-identity">
						{#if person.preview_url}<img src={person.preview_url} alt={`Preview of ${personDisplayLabel(data.pump.pump_code, person.display_seq)}`} loading="lazy" />{:else}<span class="preview-empty">No photo</span>{/if}
						<div>
							<strong>{personDisplayLabel(data.pump.pump_code, person.display_seq)}</strong>
							<span>Worker attendance</span>
						</div>
					</div>
					<div class="correction-workspace">
						<div class="attendance-fields">
							{#if morningDuplicate}
								<div class="duplicate-state"><span><strong>Morning:</strong> duplicate of {personDisplayLabel(data.pump.pump_code, morningDuplicate.kept_display_seq)}</span><button class="text-button" type="submit" formnovalidate name="resolution_id" value={morningDuplicate.id} formaction={`?/undoDuplicate&pump=${data.pump.id}&day=${data.day}`}><Undo2 size={15} /> Unmark</button></div>
							{:else}<label class="check-field"><input type="checkbox" name="morning_present" checked={person.morning_matched} disabled={!availableSessions.has('morning')} /><span>Morning present</span></label>{/if}
							{#if eveningDuplicate}
								<div class="duplicate-state"><span><strong>Evening:</strong> duplicate of {personDisplayLabel(data.pump.pump_code, eveningDuplicate.kept_display_seq)}</span><button class="text-button" type="submit" formnovalidate name="resolution_id" value={eveningDuplicate.id} formaction={`?/undoDuplicate&pump=${data.pump.id}&day=${data.day}`}><Undo2 size={15} /> Unmark</button></div>
							{:else}<label class="check-field"><input type="checkbox" name="evening_present" checked={person.evening_matched} disabled={!availableSessions.has('evening')} /><span>Evening present</span></label>{/if}
						</div>
						<div class="correction-action">
							<label class="reason-field">
								<span>Correction reason</span>
								<input name="reason" required minlength="5" maxlength="500" placeholder="What did you verify in the photo?" />
							</label>
							<button class="button button--primary" type="submit"><Save size={16} /> Save correction</button>
						</div>
						<details class="duplicate-panel">
							<summary><UserMinus size={16} /> Resolve duplicate detection</summary>
							<div class="duplicate-controls">
							<label><span>Duplicate of</span><select name="duplicate_person_id"><option value="">Select worker</option>{#each data.people.filter((candidate: any) => candidate.id !== person.id) as candidate}<option value={candidate.id}>{personDisplayLabel(data.pump.pump_code, candidate.display_seq)}</option>{/each}</select></label>
							<label><span>Duplicate reason</span><input name="duplicate_reason" minlength="5" maxlength="500" placeholder="How did you verify the duplicate?" /></label>
							<label><span>Session</span><select name="session_type">{#each ['morning', 'evening'] as type}<option value={type} disabled={!availableSessions.has(type)}>{type === 'morning' ? 'Morning' : 'Evening'}</option>{/each}</select></label>
							<button class="button button--secondary" type="submit" formnovalidate formaction={`?/markDuplicate&pump=${data.pump.id}&day=${data.day}`}><UserMinus size={16} /> Mark duplicate</button>
							</div>
						</details>
					</div>
				</form>
			{/each}
			{#if !data.people.length}<p class="empty-copy">No active workers are assigned to this pump.</p>{/if}
		</div>
	</section>

	{#if data.corrections.length}
		<section class="section" aria-labelledby="history-heading">
			<div class="section-header">
				<div><h2 id="history-heading">Correction history</h2><p class="supporting-text">Recent audited changes for this pump and date.</p></div>
			</div>
			<div class="table-wrap history-table">
				<table class="data-table">
					<thead><tr><th>Worker</th><th>Changed to</th><th>Reason</th><th>Admin</th><th>Time</th></tr></thead>
					<tbody>
						{#each data.corrections as correction}
							<tr>
								<td>{personDisplayLabel(data.pump.pump_code, correction.display_seq)}</td>
								<td>M: {correction.corrected_morning_matched ? 'Present' : 'Absent'} · E: {correction.corrected_evening_matched ? 'Present' : 'Absent'}</td>
								<td>{correction.reason}</td><td>{correction.corrected_by}</td>
								<td>{new Date(correction.corrected_at).toLocaleString()}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<div class="history-list">
				{#each data.corrections as correction}
					<article class="history-entry">
						<strong>{personDisplayLabel(data.pump.pump_code, correction.display_seq)}</strong>
						<span>M: {correction.corrected_morning_matched ? 'Present' : 'Absent'} / E: {correction.corrected_evening_matched ? 'Present' : 'Absent'}</span>
						<p>{correction.reason}</p>
						<small>{correction.corrected_by} / {new Date(correction.corrected_at).toLocaleString()}</small>
					</article>
				{/each}
			</div>
		</section>
	{/if}

	{#if data.duplicateResolutions.length}
		<section class="section" aria-labelledby="duplicate-history-heading">
			<div class="section-header"><div><h2 id="duplicate-history-heading">Duplicate history</h2><p class="supporting-text">Session-level duplicate decisions and reversals.</p></div></div>
			<div class="duplicate-history">
				{#each data.duplicateResolutions as resolution}
					<article class="history-entry" data-testid="duplicate-history-entry">
						<div><strong>{personDisplayLabel(data.pump.pump_code, resolution.duplicate_display_seq)}</strong> marked duplicate of <strong>{personDisplayLabel(data.pump.pump_code, resolution.kept_display_seq)}</strong></div>
						<span class="status-chip" class:status-chip--reversed={resolution.reversed_at}>{resolution.reversed_at ? 'Undone' : `${resolution.session_type} duplicate`}</span>
						<p>{resolution.reason}</p>
						<small>{resolution.resolved_by} / {new Date(resolution.resolved_at).toLocaleString()}</small>
						{#if !resolution.reversed_at}
							<form method="POST" use:enhance={enhanceInPlace} action={`?/undoDuplicate&pump=${data.pump.id}&day=${data.day}`}>
								<input type="hidden" name="resolution_id" value={resolution.id} />
								<button class="button button--secondary" type="submit"><Undo2 size={16} /> Unmark duplicate</button>
							</form>
						{/if}
					</article>
				{/each}
			</div>
		</section>
	{/if}
</div>

<style>
	.correction-page { --content-max: 88rem; }
	.back-link { display: inline-flex; align-items: center; gap: var(--space-1); margin-bottom: var(--space-2); }
	.notice { padding: var(--space-3) var(--space-4); border: 1px solid var(--brand-mist); border-radius: var(--radius-md); }
	.notice--success { background: var(--success-soft); }
	.notice--error { background: var(--danger-soft); }
	.evidence-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
	.evidence-item { margin: 0; overflow: hidden; border: 1px solid var(--brand-mist); border-radius: var(--radius-md); }
	.evidence-item figcaption { display: flex; justify-content: space-between; gap: var(--space-2); padding: var(--space-3); background: var(--surface-muted); text-transform: capitalize; }
	.evidence-item figcaption span { color: var(--ink-muted); }
	.evidence-item a { display: grid; height: 22rem; place-items: center; background: var(--surface-subtle); }
	.evidence-item img { display: block; width: 100%; height: 100%; object-fit: contain; }
	.evidence-empty { display: grid; min-height: 10rem; place-items: center; color: var(--ink-muted); }
	.correction-roster { display: grid; overflow: hidden; border: 1px solid var(--brand-mist); border-radius: var(--radius-lg); background: var(--surface-raised); }
	.correction-row { display: grid; grid-template-columns: minmax(13rem, 17rem) minmax(0, 1fr); align-items: start; gap: var(--space-5); padding: var(--space-5); }
	.worker-identity { display: flex; min-width: 0; align-items: center; gap: var(--space-3); }
	.worker-identity img, .preview-empty { width: 4rem; height: 4rem; flex: 0 0 4rem; border-radius: var(--radius-md); object-fit: cover; }
	.worker-identity > div { display: grid; min-width: 0; gap: .15rem; }
	.worker-identity strong { overflow-wrap: anywhere; color: var(--ink-strong); }
	.worker-identity div span { color: var(--ink-muted); font-size: var(--text-sm); }
	.preview-empty { display: grid; place-items: center; border: 1px solid var(--brand-mist); color: var(--ink-muted); font-size: var(--text-xs); }
	.correction-workspace { display: grid; min-width: 0; gap: var(--space-3); }
	.attendance-fields { display: grid; grid-template-columns: repeat(2, minmax(10rem, 1fr)); gap: var(--space-3); }
	.correction-action { display: grid; grid-template-columns: minmax(16rem, 1fr) auto; align-items: end; gap: var(--space-3); }
	.status-chip { display: inline-flex; width: fit-content; padding: .2rem .45rem; border: 1px solid var(--brand-mist); border-radius: var(--radius-sm); background: var(--success-soft); font-size: var(--text-xs); font-weight: 700; text-transform: capitalize; }
	.status-chip--reversed { background: var(--surface-muted); color: var(--ink-muted); }
	.duplicate-state { display: flex; min-height: 2.75rem; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-2) var(--space-3); border: 1px solid var(--brand-mist); border-radius: var(--radius-md); background: var(--danger-soft); font-size: var(--text-sm); }
	.text-button { display: inline-flex; min-height: 2.5rem; align-items: center; gap: var(--space-1); border: 0; background: transparent; color: var(--brand-deep); font: inherit; font-weight: 700; cursor: pointer; }
	.duplicate-panel { border-top: 1px solid var(--brand-mist); }
	.duplicate-panel summary { display: inline-flex; min-height: 2.75rem; align-items: center; gap: var(--space-2); padding-top: var(--space-2); color: var(--ink-muted); font-size: var(--text-sm); font-weight: 700; cursor: pointer; }
	.duplicate-controls { display: grid; grid-template-columns: minmax(12rem, 1fr) minmax(16rem, 2fr) minmax(8rem, .7fr) auto; align-items: end; gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--brand-mist); border-radius: var(--radius-md); background: var(--surface-subtle); }
	.duplicate-controls label { display: grid; gap: var(--space-1); }
	.duplicate-controls label > span { font-size: var(--text-sm); font-weight: 600; }
	.correction-row + .correction-row { border-top: 1px solid var(--brand-mist); }
	.check-field { display: flex; align-items: center; gap: var(--space-2); min-height: 2.75rem; padding: 0 var(--space-3); border: 1px solid var(--brand-mist); border-radius: var(--radius-md); background: var(--surface-subtle); white-space: nowrap; }
	.check-field input { width: 1.15rem; height: 1.15rem; }
	.reason-field { display: grid; gap: var(--space-1); }
	.reason-field span { font-size: var(--text-sm); font-weight: 600; }
	.reason-field input { min-width: 0; }
	.empty-copy { margin: 0; padding: var(--space-4); color: var(--ink-muted); }
	.history-list { display: none; }
	.history-entry { display: grid; gap: var(--space-1); padding: var(--space-3); border: 1px solid var(--brand-mist); border-radius: var(--radius-md); }
	.history-entry p { margin: var(--space-1) 0; }
	.history-entry small { color: var(--ink-muted); }
	.duplicate-history { display: grid; gap: var(--space-2); grid-template-columns: repeat(2, minmax(0, 1fr)); }
	.duplicate-history .history-entry { grid-template-columns: minmax(0, 1fr) auto; align-items: start; }
	.duplicate-history .status-chip { justify-self: end; }
	.duplicate-history p, .duplicate-history small, .duplicate-history form { grid-column: 1 / -1; }
	.duplicate-history form { margin-top: var(--space-2); }
	@media (max-width: 70rem) { .correction-row { grid-template-columns: 1fr; gap: var(--space-4); } .worker-identity { padding-bottom: var(--space-3); border-bottom: 1px solid var(--brand-mist); } .duplicate-controls { grid-template-columns: 1fr 1fr; } }
	@media (max-width: 44rem) { .correction-page { padding: var(--space-4); } .evidence-grid { grid-template-columns: 1fr; } .evidence-item a { height: 17rem; } .correction-row { padding: var(--space-4); } .attendance-fields, .correction-action, .duplicate-controls { grid-template-columns: 1fr; } .correction-row .button { width: 100%; } .duplicate-state { align-items: flex-start; } .history-table { display: none; } .history-list, .duplicate-history { display: grid; grid-template-columns: 1fr; gap: var(--space-2); } }
</style>
