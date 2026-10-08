<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import AttendanceEvidenceButtons from '$lib/components/AttendanceEvidenceButtons.svelte';
	import MetricStrip from '$lib/components/MetricStrip.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';

	let { data, form } = $props();
	const totals = $derived(
		data.yearly.reduce(
			(sum: any, year: any) => ({
				present: sum.present + Number(year.days_present),
				morning: sum.morning + Number(year.days_morning_only),
				evening: sum.evening + Number(year.days_evening_only)
			}),
			{ present: 0, morning: 0, evening: 0 }
		)
	);
	const metrics = $derived([
		{ label: 'Days present', value: totals.present },
		{ label: 'Morning only', value: totals.morning },
		{ label: 'Evening only', value: totals.evening },
		{ label: 'History records', value: data.history.length }
	]);
</script>

<svelte:head
	><title
		>{personDisplayLabel(data.person.pump_code, data.person.display_seq)} | Face Attendance</title
	></svelte:head
>

<div class="page person-page">
	<a class="back-link" href={resolve(`/admin/pumps/${data.person.pump_id}`)}
		><ArrowLeft size={16} /> {data.person.pump_code}</a
	>
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Anonymous person</p>
			<h1>{personDisplayLabel(data.person.pump_code, data.person.display_seq)}</h1>
			<p>
				First seen {formatDate(data.person.first_seen_at)} · Last seen {formatDate(
					data.person.last_seen_at
				)}
			</p>
		</div>
		<StatusBadge
			tone={data.person.status === 'active' ? 'active' : 'neutral'}
			label={data.person.status}
		/>
	</header>
	<MetricStrip {metrics} />
	{#if form?.message}
		<p class:alert--error={!form.success} class="alert" role="status">{form.message}</p>
	{/if}
	<section class="section">
		<div class="section-header"><h2>Yearly rollup</h2></div>
		<div class="table-wrap">
			<table class="data-table">
				<thead
					><tr><th>Year</th><th>Days present</th><th>Morning only</th><th>Evening only</th></tr
					></thead
				><tbody
					>{#each data.yearly as year}<tr
							><td><strong>{year.year}</strong></td><td>{year.days_present}</td><td
								>{year.days_morning_only}</td
							><td>{year.days_evening_only}</td></tr
						>{/each}</tbody
				>
			</table>
		</div>
	</section>
	<section class="section">
		<div class="section-header"><h2>Attendance history</h2></div>
		<div class="table-wrap">
			<table class="data-table">
				<thead
					><tr
						><th>Date</th><th>Morning</th><th>Evening</th><th>Daily status</th><th
							>Photo evidence</th
						></tr
					></thead
				><tbody
					>{#each data.history as history}<tr
							><td>{formatDate(history.session_date)}</td><td
								><StatusBadge
									tone={history.morning_matched ? 'success' : 'neutral'}
									label={history.morning_matched ? 'Matched' : 'Missing'}
								/></td
							><td
								><StatusBadge
									tone={history.evening_matched ? 'success' : 'neutral'}
									label={history.evening_matched ? 'Matched' : 'Missing'}
								/></td
							><td
								><StatusBadge
									tone={history.morning_matched && history.evening_matched ? 'success' : 'neutral'}
									label={history.morning_matched && history.evening_matched ? 'Present' : 'Partial'}
								/></td
							><td class="history-evidence">
								{#if history.morning_session_id}
									<div>
										<strong>Morning</strong>
										<AttendanceEvidenceButtons
											session={{
												id: history.morning_session_id,
												sessionType: 'morning',
												groupPhotoUrl: history.morning_photo_url
													? resolve(`/api/attendance/photo/${history.morning_session_id}`)
													: null,
												groupFlagged: history.morning_group_flagged,
												people: [
													{
														personId: data.person.id,
														label: 'Individual photo',
														cropUrl: history.morning_crop_url,
														flagged: history.morning_person_flagged
													}
												]
											}}
										/>
									</div>
								{/if}
								{#if history.evening_session_id}
									<div>
										<strong>Evening</strong>
										<AttendanceEvidenceButtons
											session={{
												id: history.evening_session_id,
												sessionType: 'evening',
												groupPhotoUrl: history.evening_photo_url
													? resolve(`/api/attendance/photo/${history.evening_session_id}`)
													: null,
												groupFlagged: history.evening_group_flagged,
												people: [
													{
														personId: data.person.id,
														label: 'Individual photo',
														cropUrl: history.evening_crop_url,
														flagged: history.evening_person_flagged
													}
												]
											}}
										/>
									</div>
								{/if}
							</td></tr
						>{/each}</tbody
				>
			</table>
		</div>
	</section>
</div>

<style>
	.person-page {
		max-width: 64rem;
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
	.history-evidence {
		min-width: 18rem;
	}
	.history-evidence > div {
		display: grid;
		gap: var(--space-1);
	}
	.history-evidence > div + div {
		margin-top: var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px solid var(--brand-mist);
	}
	.history-evidence strong {
		font-size: var(--text-xs);
		text-transform: uppercase;
	}
</style>
