<script lang="ts">
	// The day's pumps (load and actions in +page.server.ts), in three plain groups: needs a look,
	// checked, no problems. Each pump says in one sentence what is wrong; tapping it opens Fix
	// attendance, Done marks it checked. Phone first.
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import Check from '@lucide/svelte/icons/check';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { formatDate, formatTime } from '$lib/date';
	import type { PumpCheck } from '$lib/server/pumpChecks';

	let { data, form } = $props();

	const isToday = $derived(data.day === data.today);
	const groups = $derived([
		{
			key: 'todo',
			title: 'Needs a look',
			pumps: data.pumps.filter((p: PumpCheck) => p.problems.length && !p.check)
		},
		{ key: 'checked', title: 'Checked', pumps: data.pumps.filter((p: PumpCheck) => p.check) },
		{
			key: 'fine',
			title: 'No problems',
			pumps: data.pumps.filter((p: PumpCheck) => !p.problems.length && !p.check)
		}
	]);

	// One plain sentence: what is wrong, or how the day went.
	function says(pump: PumpCheck) {
		const problems = pump.problems.map((problem) =>
			problem.endsWith('fraud')
				? 'Fraud found'
				: problem === 'Photo failed'
					? 'A photo failed'
					: problem === 'No photo'
						? isToday
							? 'No photo yet'
							: 'No photo this day'
						: problem === 'No start photo'
							? 'Only an end photo, no start photo'
							: problem === 'No end photo'
								? `Started ${formatTime(pump.startAt!)}, no end photo`
								: problem.replace(
										'not a full shift',
										`of ${pump.total} workers not counted for the full shift`
									)
		);
		if (problems.length) return problems.join(' · ');
		if (pump.startAt && !pump.endAt) return `Started ${formatTime(pump.startAt)}, shift still on`;
		return `Full shift, all ${pump.total} ${pump.total === 1 ? 'worker' : 'workers'} counted`;
	}

	const dayLink = (day: string) =>
		resolve('/plant-manager') + (day === data.today ? '' : `?day=${day}`);
	const fixLink = (pumpId: string) =>
		resolve('/plant-manager/attendance/correct') + `?pump=${pumpId}&day=${data.day}`;
	const keep =
		() =>
		async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) =>
			update({ reset: false });
</script>

<svelte:head><title>Pumps today | Face Attendance</title></svelte:head>

<div class="page">
	<header class="head">
		<h1>{isToday ? 'Pumps today' : 'Pumps yesterday'}</h1>
		<nav class="days" aria-label="Day">
			<a href={dayLink(data.today)} aria-current={isToday ? 'page' : undefined}>Today</a>
			<a href={dayLink(data.yesterday)} aria-current={!isToday ? 'page' : undefined}>Yesterday</a>
		</nav>
	</header>
	<p class="date">{formatDate(data.day)}</p>

	{#if !data.pumps.length}
		<EmptyState
			title="No pumps yet"
			description="Ask an administrator to give you plants or areas to look after."
		/>
	{/if}

	{#each groups as group (group.key)}
		{#if group.pumps.length}
			<section class="group group--{group.key}" data-testid="checklist-{group.key}">
				<h2>{group.title} <span>{group.pumps.length}</span></h2>
				{#if group.key === 'todo'}
					<p class="hint">
						Tap a pump to fix its attendance. Press Done when you have dealt with it.
					</p>
				{/if}
				<ul>
					{#each group.pumps as pump (pump.pumpId)}
						<li class="pump" data-testid="checklist-pump">
							<a class="pump__open" href={fixLink(pump.pumpId)}>
								<span class="pump__text">
									<strong>{pump.pumpCode}</strong>
									<small>{pump.plantName}</small>
									<span class="pump__says" class:pump__says--fraud={pump.fraud > 0}
										>{says(pump)}</span
									>
									{#if pump.check}<span class="pump__by" data-testid="checklist-checked"
											>Checked by {pump.check.by}, {formatTime(pump.check.at)}</span
										>{/if}
								</span>
								<ChevronRight size={18} />
							</a>
							{#if group.key === 'todo'}
								<form method="POST" action="?/check" use:enhance={keep}>
									<input type="hidden" name="pump_id" value={pump.pumpId} />
									<input type="hidden" name="day" value={data.day} />
									<button class="done" type="submit" data-testid="checklist-check"
										><Check size={16} /> Done</button
									>
								</form>
							{:else if group.key === 'checked'}
								<form method="POST" action="?/uncheck" use:enhance={keep}>
									<input type="hidden" name="pump_id" value={pump.pumpId} />
									<input type="hidden" name="day" value={data.day} />
									<button class="undo" type="submit">Undo</button>
								</form>
							{/if}
							{#if form?.pumpId === pump.pumpId && form?.error}
								<p class="row-error" role="alert">{form.error}</p>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/each}
</div>

<style>
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	h1 {
		margin: 0;
	}
	.date {
		margin: var(--space-1) 0 var(--space-4);
		color: var(--ink-muted);
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
	.group {
		max-width: 48rem;
		margin-bottom: var(--space-5);
	}
	h2 {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0 0 var(--space-2);
		font-size: var(--text-lg);
	}
	h2 span {
		min-width: 1.75rem;
		padding: 0 0.5rem;
		color: var(--ink-strong);
		font-size: var(--text-sm);
		text-align: center;
		background: var(--surface-muted);
		border-radius: 999px;
	}
	.group--todo h2 span {
		color: var(--surface-raised);
		background: var(--alert);
	}
	.hint {
		margin: 0 0 var(--space-2);
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	ul {
		margin: 0;
		padding: 0;
		list-style: none;
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.pump {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding-right: var(--space-3);
	}
	.pump + .pump {
		border-top: 1px solid var(--brand-mist);
	}
	.pump__open {
		display: flex;
		flex: 1;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		padding: var(--space-3);
		color: var(--ink-default);
		text-decoration: none;
	}
	.pump__open :global(svg) {
		flex: none;
		color: var(--ink-muted);
	}
	.pump__text {
		display: grid;
		flex: 1;
		min-width: 0;
	}
	.pump__text strong {
		color: var(--ink-strong);
	}
	small {
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}
	.pump__says {
		margin-top: var(--space-1);
		font-size: var(--text-sm);
	}
	.group--todo .pump__says {
		color: var(--alert);
		font-weight: 600;
	}
	.pump__says--fraud {
		color: var(--alert);
		font-weight: 700;
	}
	.pump__by {
		color: var(--brand-teal);
		font-size: var(--text-xs);
		font-weight: 600;
	}
	.done,
	.undo {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: 2.5rem;
		padding: 0 var(--space-3);
		font: inherit;
		font-weight: 600;
		border-radius: var(--radius-md);
		cursor: pointer;
	}
	.done {
		color: var(--brand-teal);
		background: var(--surface-raised);
		border: 1px solid var(--brand-teal);
	}
	.undo {
		color: var(--ink-muted);
		background: none;
		border: 0;
	}
	.row-error {
		flex: 1 1 100%;
		margin: 0 0 var(--space-2) var(--space-3);
		color: var(--alert);
		font-size: var(--text-sm);
	}
</style>
