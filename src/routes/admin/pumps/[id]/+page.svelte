<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import DateRangePicker from '$lib/components/DateRangePicker.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';

	let { data } = $props();
	let from = $state('');
	let to = $state('');
	$effect(() => {
		if (!from) from = data.range.from;
		if (!to) to = data.range.to;
	});
	const entities = $derived(
		data.roster.map((person: any) => ({
			id: person.id,
			label: personDisplayLabel(data.pump.pump_code, person.display_seq)
		}))
	);

	function apply() {
		window.location.search = new URLSearchParams({ from, to }).toString();
	}
	function cellValue(personId: string, day: string) {
		return data.attendanceMap[`${personId}|${day}`] ?? 'absent';
	}
</script>

<svelte:head><title>{data.pump.pump_code} | Face Attendance</title></svelte:head>

<div class="page detail-page">
	<a class="back-link" href="/admin/attendance"><ArrowLeft size={16} /> Attendance records</a>
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Pump</p>
			<h1>{data.pump.pump_code}</h1>
			<p>
				<a href={`/admin/vendors/${data.pump.vendor_id}`}>{data.pump.vendor_name}</a> · {data.pump
					.plant_name} · <a href={`/admin/areas/${data.pump.area_id}`}>{data.pump.area_name}</a>
			</p>
		</div>
	</header>
	<DateRangePicker bind:from bind:to onchange={apply} />

	<div class="pump-summary section">
		<section class="surface surface--padded">
			<div class="section-header">
				<div>
					<h2>Attendance trend</h2>
					<p class="supporting-text">Complete attendance in this range.</p>
				</div>
			</div>
			<Sparkline
				values={data.sparkline}
				width={500}
				height={80}
				label={`${data.pump.pump_code} attendance trend`}
			/>
		</section>
		<section class="surface surface--padded">
			<p class="eyebrow">Pairing health</p>
			<strong>{data.rejectionCounts.morningExpired}</strong>
			<p>Morning sessions expired without an evening pair in this range.</p>
		</section>
	</div>

	<section class="section">
		<div class="section-header">
			<div>
				<h2>Attendance calendar</h2>
				<p class="supporting-text">Person status by day.</p>
			</div>
		</div>
		<AttendanceCalendarGrid days={data.days} {entities} {cellValue} mode="status" />
	</section>

	<section class="section">
		<div class="section-header">
			<div>
				<h2>Session log</h2>
				<p class="supporting-text">Persisted sessions and pairing outcomes.</p>
			</div>
		</div>
		<div class="table-wrap">
			<table class="data-table">
				<thead
					><tr
						><th>Submitted</th><th>Type</th><th>Status</th><th>Pairing</th><th
							>Error or rejection</th
						></tr
					></thead
				><tbody
					>{#each data.sessionLog as session}<tr
							><td>{formatDate(session.submitted_at)}</td><td>{session.session_type}</td><td
								><StatusBadge
									tone={session.status === 'completed'
										? 'success'
										: session.status === 'failed'
											? 'critical'
											: 'pending'}
									label={session.status}
								/></td
							><td>{session.pairing_status}</td><td
								>{session.error_reason ||
									(session.pairing_status === 'expired'
										? 'Morning session expired unpaired'
										: '—')}</td
							></tr
						>{/each}</tbody
				>
			</table>
		</div>
		<p class="footnote">
			Nine-hour and duplicate-photo rejections occur before a session is created, so only the
			operator’s live response contains them.
		</p>
	</section>

	<section class="section">
		<div class="section-header"><h2>Worker roster</h2></div>
		<div class="table-wrap">
			<table class="data-table">
				<thead
					><tr
						><th>Person</th><th>First seen</th><th>Last seen</th><th>Present</th><th
							>Morning only</th
						><th>Evening only</th></tr
					></thead
				><tbody
					>{#each data.roster as person}<tr
							><td
								><a href={`/admin/persons/${person.id}`}
									>{personDisplayLabel(data.pump.pump_code, person.display_seq)}</a
								></td
							><td>{formatDate(person.first_seen_at)}</td><td>{formatDate(person.last_seen_at)}</td
							><td>{person.days_present}</td><td>{person.days_morning_only}</td><td
								>{person.days_evening_only}</td
							></tr
						>{/each}</tbody
				>
			</table>
		</div>
	</section>
</div>

<style>
	.detail-page {
		--content-max: 82rem;
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
		grid-template-columns: minmax(0, 1.5fr) minmax(15rem, 0.6fr);
		gap: var(--space-4);
	}
	.pump-summary :global(.sparkline) {
		width: 100%;
		height: 5rem;
	}
	.pump-summary section:last-child > strong {
		display: block;
		color: var(--ink-strong);
		font-size: var(--text-3xl);
	}
	.pump-summary section:last-child p:last-child,
	.footnote {
		margin: var(--space-2) 0 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	@media (max-width: 48rem) {
		.pump-summary {
			grid-template-columns: 1fr;
		}
	}
</style>
