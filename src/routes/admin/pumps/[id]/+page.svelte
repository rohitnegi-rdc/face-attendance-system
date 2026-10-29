<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import AttendanceDailyBars from '$lib/components/AttendanceDailyBars.svelte';
	import DateRangePicker from '$lib/components/DateRangePicker.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import FacePeek from '$lib/components/FacePeek.svelte';
	import ShiftLog from '$lib/components/ShiftLog.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate, formatDateTime, formatDayLabel } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';
	import { shiftTypeLabel } from '$lib/shiftLabels';

	let { data, form } = $props();
	let from = $state('');
	let to = $state('');
	$effect(() => {
		if (!from) from = data.range.from;
		if (!to) to = data.range.to;
	});
	const entities = $derived(
		data.roster.map((person: any) => ({
			id: person.id,
			label: personDisplayLabel(
				data.pump.pump_code,
				person.display_seq,
				person.is_operator,
				person.name
			),
			faceUrl: resolve('/api/persons/[id]/face', { id: person.id })
		}))
	);
	const dailyBreakdownTotals = $derived(
		data.dailyBreakdown.reduce(
			(acc: any, d: any) => ({
				present: acc.present + d.present,
				morningOnly: acc.morningOnly + d.morningOnly,
				eveningOnly: acc.eveningOnly + d.eveningOnly
			}),
			{ present: 0, morningOnly: 0, eveningOnly: 0 }
		)
	);
	let showEmptyDays = $state(false);
	const hasAttendance = (d: any) => d.present + d.morningOnly + d.eveningOnly > 0;
	const emptyDayCount = $derived(data.dailyBreakdown.filter((d: any) => !hasAttendance(d)).length);
	const summaryDays = $derived(
		[...data.dailyBreakdown].reverse().filter((d: any) => showEmptyDays || hasAttendance(d))
	);
	const rangeLabel = $derived(`${formatDate(data.range.from)} – ${formatDate(data.range.to)}`);
	const trendData = $derived(data.dailyBreakdown.slice(-5));

	function apply() {
		window.location.search = new URLSearchParams({ from, to }).toString();
	}
	function cellValue(personId: string, day: string) {
		return data.attendanceMap[`${personId}|${day}`] ?? 'absent';
	}
	function pageUrl(param: string, n: number) {
		const params = new URLSearchParams(page.url.search);
		params.set(param, String(n));
		return `?${params.toString()}`;
	}
</script>

<svelte:head><title>{data.pump.pump_code} | Face Attendance</title></svelte:head>

<div class="page detail-page">
	<a class="back-link" href={resolve('/admin/attendance')}
		><ArrowLeft size={16} /> Attendance records</a
	>
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Pump</p>
			<h1>{data.pump.pump_code}</h1>
			<p>
				<a href={resolve(`/admin/vendors/${data.pump.vendor_id}`)}>{data.pump.vendor_name}</a> · {data
					.pump.plant_name} ·
				<a href={resolve(`/admin/areas/${data.pump.area_id}`)}>{data.pump.area_name}</a>
			</p>
		</div>
	</header>
	{#if data.pump.status === 'disabled'}
		<div class="alert alert--error" role="status">
			<p>
				<strong>Pump login disabled</strong> — {data.pump.disabled_reason ?? 'unknown reason'}
				{#if data.pump.disabled_at}(since {formatDate(data.pump.disabled_at)}){/if}
			</p>
			<form method="POST" action="?/reactivatePump">
				<button type="submit">Reactivate login</button>
			</form>
		</div>
	{/if}

	<DateRangePicker bind:from bind:to onchange={apply} />

	{#if form?.message}
		<p class:alert--error={!form.success} class="alert" role="status">{form.message}</p>
	{/if}

	<div class="pump-summary section">
		<section class="surface surface--padded">
			<div class="section-header">
				<div>
					<h2>Attendance trend</h2>
					<p class="supporting-text">Latest five days, with newest first.</p>
				</div>
			</div>
			<div class="daily-bars-frame">
				<AttendanceDailyBars data={trendData} />
			</div>
		</section>
		<section class="surface surface--padded">
			<div class="section-header">
				<div>
					<h2>Daily attendance summary</h2>
					<p class="supporting-text">People counted per day, {rangeLabel}.</p>
				</div>
			</div>
			{#if summaryDays.length === 0}
				<p class="supporting-text">No attendance in this range.</p>
			{:else}
				<div class="table-wrap daily-summary-frame">
					<table class="data-table daily-summary-table">
						<thead>
							<tr>
								<th>Day</th>
								<th>Full</th>
								<th>Start only</th>
								<th>End only</th>
							</tr>
						</thead>
						<tbody>
							{#each summaryDays as d (d.day)}
								{@const label = formatDayLabel(d.day)}
								<tr>
									<td class="day-cell">{label.weekday} {label.date}</td>
									<td class:zero={!d.present}>{d.present}</td>
									<td class:zero={!d.morningOnly}>{d.morningOnly}</td>
									<td class:zero={!d.eveningOnly}>{d.eveningOnly}</td>
								</tr>
							{/each}
						</tbody>
						<tfoot>
							<tr>
								<th>Total</th>
								<th>{dailyBreakdownTotals.present}</th>
								<th>{dailyBreakdownTotals.morningOnly}</th>
								<th>{dailyBreakdownTotals.eveningOnly}</th>
							</tr>
						</tfoot>
					</table>
				</div>
			{/if}
			{#if emptyDayCount > 0}
				<button type="button" class="link-button" onclick={() => (showEmptyDays = !showEmptyDays)}>
					{showEmptyDays
						? 'Hide days with no attendance'
						: `Show ${emptyDayCount} day${emptyDayCount === 1 ? '' : 's'} with no attendance`}
				</button>
			{/if}
			{#if data.rejectionCounts.morningOnly > 0}
				<p class="footnote">
					Shifts with no end photo: {data.rejectionCounts.morningExpired} closed &middot;
					{data.rejectionCounts.morningAwaiting} still open
				</p>
			{/if}
		</section>
	</div>

	<section class="section">
		<div class="section-header">
			<div>
				<h2>Attendance calendar</h2>
				<p class="supporting-text">
					Person status by day, {rangeLabel} &middot; scroll for more days
				</p>
			</div>
		</div>
		<div class="calendar-frame">
			<AttendanceCalendarGrid
				days={data.days}
				{entities}
				{cellValue}
				mode="status"
				entityLabel="Person"
			/>
		</div>
		{#if data.rosterPagination.totalPages > 1}
			<nav class="pager" aria-label="Roster pagination">
				{#if data.rosterPagination.page > 1}<a
						class="button button--secondary"
						href={pageUrl('roster_page', data.rosterPagination.page - 1)}>Previous</a
					>{:else}<span></span>{/if}
				<span>Page {data.rosterPagination.page} of {data.rosterPagination.totalPages}</span>
				{#if data.rosterPagination.page < data.rosterPagination.totalPages}<a
						class="button button--secondary"
						href={pageUrl('roster_page', data.rosterPagination.page + 1)}>Next</a
					>{/if}
			</nav>
		{/if}
	</section>

	<section class="section">
		<div class="section-header">
			<div>
				<h2>Session log</h2>
				<p class="supporting-text">
					{data.sessionPagination.total}
					{data.sessionPagination.total === 1 ? 'shift' : 'shifts'} in this range, newest first, start
					and end photo side by side. Fix attendance ticks workers in or out; Fix shift ends a shift the
					pump forgot to end or moves it to another date. Every fix is in the admin audit log.
				</p>
			</div>
		</div>
		{#if data.shifts.length}
			<ShiftLog
				shifts={data.shifts}
				page={data.sessionPagination.page}
				pageSize={data.sessionPagination.pageSize}
				allowFlag
				allowRename
				fixHref={(_shift, day) =>
					resolve(`/admin/attendance/correct?pump=${data.pump.id}&day=${day}`)}
			>
				{#snippet actions(session)}
					{#if session.test_mode}<span data-testid="test-mode-session"
							><StatusBadge tone="attention" label="Taken in test mode" /></span
						>{/if}
					{#if session.status === 'fraud_detected'}<div class="fraud-review">
							{#if session.fraud_resolution === 'marked_normal'}<span
									>Marked normal — reprocessed</span
								>{:else if session.fraud_resolution === 'confirmed_fraud'}<span
									>Confirmed fraud</span
								>{:else}<form method="POST" action="?/resolveFraudSession">
									<input type="hidden" name="session_id" value={session.id} /><input
										type="hidden"
										name="resolution"
										value="marked_normal"
									/><button type="submit" class="button button--secondary">Mark as normal</button>
								</form>
								<form method="POST" action="?/resolveFraudSession">
									<input type="hidden" name="session_id" value={session.id} /><input
										type="hidden"
										name="resolution"
										value="confirmed_fraud"
									/><button type="submit" class="button button--secondary">Confirm fraud</button>
								</form>{/if}
						</div>{/if}
					<form
						method="POST"
						action="?/deleteSession"
						onsubmit={(event) => {
							const scope =
								session.session_type === 'morning' && session.pairing_status === 'paired'
									? 'this shift start and its shift end'
									: `this ${shiftTypeLabel(session.session_type).toLowerCase()}`;
							if (
								!confirm(
									`Delete ${scope}? Attendance, new workers and fraud flags from it are removed and the pump can submit again. This cannot be undone.`
								)
							)
								event.preventDefault();
						}}
					>
						<input type="hidden" name="session_id" value={session.id} /><button
							type="submit"
							class="button button--secondary">Delete / reset</button
						>
					</form>
					{#if session.status !== 'fraud_detected'}
						<details class="shift-fix" data-testid="shift-fix">
							<summary>Fix shift</summary>
							<div class="shift-fix__body">
								{#if session.session_type === 'morning' && session.pairing_status === 'open' && session.status === 'completed'}
									<form
										method="POST"
										action="?/endShift"
										onsubmit={(event) => {
											if (
												!confirm(
													'End this shift now? Workers keep start-only attendance and the next photo starts a new shift.'
												)
											)
												event.preventDefault();
										}}
									>
										<input type="hidden" name="session_id" value={session.id} />
										<button type="submit" class="button button--secondary">End session</button>
										<small>Close it as start only.</small>
									</form>
								{/if}
								{#if session.session_type === 'evening'}
									<form
										method="POST"
										action="?/splitShift"
										onsubmit={(event) => {
											if (
												!confirm(
													'Make this photo a new shift start? The earlier start becomes start only and attendance from this photo moves to the day it was taken.'
												)
											)
												event.preventDefault();
										}}
									>
										<input type="hidden" name="session_id" value={session.id} />
										<button type="submit" class="button button--secondary"
											>Split: this end is a new start</button
										>
										<small>Use when the pump forgot to end the previous shift.</small>
									</form>
								{/if}
								<form method="POST" action="?/moveShift" class="shift-fix__move">
									<input type="hidden" name="session_id" value={session.id} />
									<label>
										Move shift to
										<input type="date" name="new_date" required />
									</label>
									<button type="submit" class="button button--secondary">Move</button>
									<small>Moves the start, its end and that day's attendance together.</small>
								</form>
							</div>
						</details>
					{/if}
				{/snippet}
			</ShiftLog>
		{:else}<EmptyState title="No sessions" description="Pump submissions will appear here." />{/if}
		<p class="footnote">
			Shift end too early and duplicate-photo rejections occur before a session is created, so only
			the operator’s live response contains them.
		</p>
		{#if data.sessionPagination.totalPages > 1}
			<nav class="pager" aria-label="Session log pagination">
				{#if data.sessionPagination.page > 1}<a
						class="button button--secondary"
						href={pageUrl('session_page', data.sessionPagination.page - 1)}>Previous</a
					>{:else}<span></span>{/if}
				<span>Page {data.sessionPagination.page} of {data.sessionPagination.totalPages}</span>
				{#if data.sessionPagination.page < data.sessionPagination.totalPages}<a
						class="button button--secondary"
						href={pageUrl('session_page', data.sessionPagination.page + 1)}>Next</a
					>{/if}
			</nav>
		{/if}
	</section>

	<section class="section">
		<div class="section-header"><h2>Worker roster</h2></div>
		<div class="table-wrap bounded-table-frame">
			<table class="data-table">
				<thead
					><tr
						><th>Person</th><th>First seen</th><th>Last seen</th><th>Full shift</th><th
							>Start only</th
						><th>End only</th></tr
					></thead
				><tbody
					>{#each data.roster as person}<tr
							><td
								><span class="worker-tag"
									><FacePeek
										url={resolve('/api/persons/[id]/face', { id: person.id })}
										label={personDisplayLabel(
											data.pump.pump_code,
											person.display_seq,
											person.is_operator,
											person.name
										)}
									/><a href={resolve(`/admin/persons/${person.id}`)}
										>{personDisplayLabel(
											data.pump.pump_code,
											person.display_seq,
											person.is_operator,
											person.name
										)}</a
									></span
								></td
							><td>{formatDate(person.first_seen_at)}</td><td>{formatDate(person.last_seen_at)}</td
							><td>{person.days_present}</td><td>{person.days_morning_only}</td><td
								>{person.days_evening_only}</td
							></tr
						>{/each}</tbody
				>
			</table>
		</div>
		<p class="footnote">Same page as the calendar above — use its pager to see more people.</p>
	</section>

	<section class="surface surface--padded section" aria-labelledby="gps-heading">
		<h2 id="gps-heading">Pump GPS</h2>
		<p class="supporting-text">
			{#if data.pump.location_check_enabled}
				Shift starts at {data.pump.area_name} are checked against this position (100 m).
			{:else}
				{data.pump.area_name} does not use the location check yet.
			{/if}
			Latest position:
			{#if data.pump.latest_gps}
				<a
					href={`https://www.google.com/maps?q=${data.pump.latest_gps.lat},${data.pump.latest_gps.lng}`}
					target="_blank"
					rel="noopener">{data.pump.latest_gps.lat}, {data.pump.latest_gps.lng}</a
				>
				({data.pump.latest_gps.source === 'admin' ? 'entered by admin' : 'GPS feed'},
				{data.pump.latest_gps.at}).
			{:else}
				none received yet.
			{/if}
		</p>
		<div class="gps-forms">
			<form method="POST" action="?/setPumpGps" class="gps-form">
				<label class="field"
					><span>Set position now (lat, lng)</span><input
						name="coords"
						placeholder="19.0596, 72.9165"
						required
					/></label
				>
				<button class="button button--secondary" type="submit">Save position</button>
			</form>
			<form method="POST" action="?/setGpsDeviceId" class="gps-form">
				<label class="field"
					><span>GPS provider id (if not the pump code)</span><input
						name="gps_device_id"
						value={data.pump.gps_device_id ?? ''}
						placeholder={data.pump.pump_code}
					/></label
				>
				<button class="button button--secondary" type="submit">Save id</button>
			</form>
		</div>
	</section>

	<section class="surface surface--padded section danger-zone" aria-labelledby="danger-heading">
		<h2 id="danger-heading">Clear test records</h2>
		<p class="supporting-text">
			Deletes only the shifts {data.pump.pump_code} took while test mode was on (marked "Taken in test
			mode" in the Session log), with their photos, roll-ups, fraud flags and the workers seen only in
			them. Genuine shifts and workers are never deleted. The pump login stays and the action is in the
			admin audit log.
		</p>
		<p class="test-count" data-testid="test-session-count">
			{#if data.testSessions.sessions}
				<strong>{data.testSessions.sessions}</strong>
				{data.testSessions.sessions === 1 ? 'photo' : 'photos'} taken in test mode{#if data.testSessions.sessions === 1 && data.testSessions.first},
					on {formatDateTime(
						data.testSessions.first
					)}{:else if data.testSessions.first && data.testSessions.last}, from {formatDateTime(
						data.testSessions.first
					)} to {formatDateTime(data.testSessions.last)}{/if}.
			{:else}
				No shifts taken in test mode. Genuine records can only be deleted one shift at a time from
				the Session log.
			{/if}
		</p>
		{#if data.testSessions.sessions}
			<form
				method="POST"
				action="?/clearPumpData"
				class="danger-form"
				onsubmit={(event) => {
					if (
						!confirm(
							`Delete the ${data.testSessions.sessions} test-mode photo(s) of ${data.pump.pump_code}? Genuine shifts stay. This cannot be undone.`
						)
					)
						event.preventDefault();
				}}
			>
				<label>
					Type <strong>{data.pump.pump_code}</strong> to confirm
					<input name="confirm_code" autocomplete="off" required />
				</label>
				<button type="submit" class="button button--secondary">Delete test records</button>
			</form>
		{/if}
	</section>
</div>

<style>
	.test-count {
		margin: var(--space-3) 0;
	}
	.detail-page {
		--content-max: 82rem;
	}
	.fraud-review {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		align-items: center;
	}
	.fraud-review form {
		display: contents;
	}
	.danger-zone {
		border: 1px solid var(--critical, #b42318);
	}
	/* Admin tools under each photo: Delete / reset beside Fix shift, which opens full width. */
	.shift-fix[open] {
		flex-basis: 100%;
	}
	/* Same compact outlined button as Delete / reset beside it (ShiftLog styles the buttons). */
	.shift-fix summary {
		display: inline-flex;
		align-items: center;
		min-height: 2.75rem;
		padding: 0 var(--space-3);
		cursor: pointer;
		font-size: var(--text-sm);
		font-weight: 700;
		color: var(--brand-teal);
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.shift-fix summary:hover {
		border-color: var(--brand-teal);
	}
	.shift-fix__body {
		display: grid;
		gap: var(--space-3);
		margin-top: var(--space-2);
		padding: var(--space-3);
		background: var(--surface-subtle);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.shift-fix__body form {
		display: grid;
		gap: var(--space-1);
		justify-items: start;
	}
	.shift-fix__body small {
		color: var(--ink-muted);
	}
	.shift-fix__move label {
		display: grid;
		gap: var(--space-1);
		font-size: var(--text-sm);
	}
	.danger-form {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: end;
	}
	.danger-form label {
		display: grid;
		gap: var(--space-1);
	}
	.back-link {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		margin-bottom: var(--space-5);
		font-size: var(--text-sm);
		font-weight: 600;
		text-decoration: none;
	}
	.eyebrow {
		margin: 0 0 var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
	}
	.pump-summary {
		display: grid;
		grid-template-columns: minmax(0, 55fr) minmax(20rem, 35fr);
		gap: var(--space-4);
	}
	.daily-summary-table th,
	.daily-summary-table td {
		text-align: right;
	}
	.daily-summary-table th:first-child,
	.daily-summary-table td:first-child {
		text-align: left;
	}
	.daily-summary-table .day-cell {
		white-space: nowrap;
	}
	.daily-summary-table td.zero {
		color: var(--ink-muted);
	}
	.link-button {
		margin-top: var(--space-2);
		padding: 0;
		border: 0;
		background: none;
		color: var(--brand-teal);
		font: inherit;
		font-size: var(--text-sm);
		text-decoration: underline;
		cursor: pointer;
	}
	.daily-summary-frame {
		max-height: 25rem;
		overflow-x: hidden;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
		scrollbar-width: thin;
		scrollbar-color: var(--brand-mist) var(--surface-muted);
	}
	.daily-summary-table thead th {
		position: sticky;
		top: 0;
		z-index: 3;
	}
	.daily-summary-table tfoot th {
		position: sticky;
		top: auto;
		bottom: 0;
		z-index: 3;
		background: var(--surface-muted);
		box-shadow: 0 -1px 0 var(--brand-mist);
	}
	.daily-bars-frame {
		overflow: hidden;
	}
	.bounded-table-frame {
		max-height: 22rem;
		overflow: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
		scrollbar-width: thin;
		scrollbar-color: var(--brand-mist) var(--surface-muted);
	}
	.footnote {
		margin: var(--space-2) 0 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.calendar-frame :global(.grid-wrap) {
		width: 100%;
	}
	.pager {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		margin-top: var(--space-3);
	}
	@media (max-width: 48rem) {
		.pump-summary {
			grid-template-columns: 1fr;
		}
	}
	.gps-forms {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-4);
		margin-top: var(--space-3);
	}
	.gps-form {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-2);
	}
</style>
