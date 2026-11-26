<script lang="ts">
	// One pump's day (load in +page.server.ts), opened by View attendance on Pumps today: status and
	// site, who was counted, and the shift with its start and end photos. Back goes to Pumps today.
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import BackLink from '$lib/components/BackLink.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import ShiftLog from '$lib/components/ShiftLog.svelte';
	import ShiftSplit from '$lib/components/ShiftSplit.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { PUMP_WORK_STATUS_LABELS } from '$lib/pumpWorkStatus';
	import { formatHumanDay } from '$lib/date';

	let { data } = $props();

	const isToday = $derived(data.day === data.today);
	// Back goes to the page this was opened from (BackLink); opened directly: ?from=pumps the Pumps
	// page, otherwise Pumps today.
	const fromPumps = $derived(page.url.searchParams.get('from') === 'pumps');
	const back = $derived(
		fromPumps
			? { href: resolve('/plant-manager/pumps'), label: 'Pumps' }
			: {
					href: resolve('/plant-manager') + (isToday ? '' : `?day=${data.day}`),
					label: isToday ? 'Pumps today' : 'Pumps yesterday'
				}
	);
	const dayLink = (day: string) => {
		const params = new URLSearchParams();
		if (day !== data.today) params.set('day', day);
		if (fromPumps) params.set('from', 'pumps');
		const query = params.toString();
		return resolve('/plant-manager/pumps/[id]', { id: data.pump.id }) + (query ? `?${query}` : '');
	};
	const counted = $derived(data.counts.full + data.counts.start_only + data.counts.end_only);
	const status = $derived(data.pump.work_status);
</script>

<svelte:head><title>{data.pump.pump_code} | Face Attendance</title></svelte:head>

<div class="page pump-day" data-testid="pm-pump-day">
	<BackLink href={back.href} label={back.label} testId="pm-pump-day-back" />

	<header class="head">
		<div class="title">
			<h1>{data.pump.pump_code}</h1>
			<StatusBadge
				tone={status === 'active' ? 'success' : status === 'idle' ? 'pending' : 'neutral'}
				label={PUMP_WORK_STATUS_LABELS[status]}
			/>
		</div>
		<nav class="days" aria-label="Day">
			<a href={dayLink(data.today)} aria-current={isToday ? 'page' : undefined}>Today</a>
			<a
				href={dayLink(data.yesterday)}
				aria-current={data.day === data.yesterday ? 'page' : undefined}>Yesterday</a
			>
		</nav>
	</header>
	<p class="meta">
		<strong>{formatHumanDay(data.day)}</strong>
		<span>{data.pump.plant_name} · {data.pump.vendor_name}</span>
		{#if data.pump.site_name}<span data-testid="pm-pump-day-site">Site: {data.pump.site_name}</span
			>{/if}
	</p>

	{#if counted || data.shifts.length}
		<section class="counted" aria-label="Workers counted" data-testid="pm-pump-day-counted">
			<p class="counted__total">
				<strong>{counted}</strong>
				{counted === 1 ? 'worker' : 'workers'} counted
			</p>
			<ShiftSplit
				full={data.counts.full}
				startOnly={data.counts.start_only}
				endOnly={data.counts.end_only}
			/>
		</section>
	{/if}

	{#if data.shifts.length}
		<ShiftLog
			shifts={data.shifts}
			page={1}
			pageSize={data.shifts.length}
			allowRename
			photosOnLatestDay
			fixHref={(shift, day) =>
				resolve('/plant-manager/attendance/correct') +
				`?pump=${shift.pump_id}&day=${day}&from=pump${fromPumps ? '&via=pumps' : ''}`}
			fraudCaseHref={(id) => resolve('/plant-manager/approvals/fraud/[id]', { id })}
		/>
	{:else}
		<EmptyState
			title={isToday ? 'No photo yet' : 'No photo this day'}
			description={status === 'idle'
				? 'The pump is Idle: no work, so no photo is expected.'
				: 'The start and end photos show here once the pump sends them.'}
		/>
	{/if}
</div>

<style>
	.pump-day {
		display: grid;
		gap: var(--space-3);
		max-width: 48rem;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.title {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	h1 {
		margin: 0;
	}
	.days {
		display: flex;
		gap: var(--space-1);
	}
	.days a {
		display: inline-flex;
		align-items: center;
		min-height: 2.5rem;
		padding: 0 var(--space-3);
		color: var(--ink-default);
		font-weight: 600;
		text-decoration: none;
		border: 1px solid var(--brand-mist);
		border-radius: 999px;
	}
	.days a[aria-current='page'] {
		color: var(--surface-raised);
		background: var(--brand-teal);
		border-color: var(--brand-teal);
	}
	.meta {
		display: grid;
		gap: 2px;
		margin: 0;
		color: var(--ink-muted);
	}
	.meta strong {
		color: var(--ink-strong);
	}
	.counted {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3);
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.counted__total {
		margin: 0;
		font-size: var(--text-lg);
	}
	.counted__total strong {
		color: var(--ink-strong);
		font-size: var(--text-2xl, 1.5rem);
	}
</style>
