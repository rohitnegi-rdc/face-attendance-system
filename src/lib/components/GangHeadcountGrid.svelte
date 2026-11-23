<script lang="ts">
	// The By gang view of the Attendance pages (gangGrid in src/lib/server/gangs.ts): gang x day
	// headcount, each worker once a day, wherever the gang worked. Amber = the shift start waits for
	// its location approval or was rejected (as on the pump sheet): shown, left out of the total row.
	import { resolve } from '$app/paths';
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import type { gangGrid } from '$lib/server/gangs';

	type View = NonNullable<Awaited<ReturnType<typeof gangGrid>>>;
	let { view, days, base }: { view: View; days: string[]; base: 'admin' | 'plant-manager' } =
		$props();

	const TOTAL = '__total__';
	const entities = $derived([
		...view.gangs.map((gang) => ({
			id: gang.id,
			label: gang.label,
			href:
				base === 'admin'
					? resolve('/admin/gangs/[id]', { id: gang.id })
					: resolve('/plant-manager/gangs/[id]', { id: gang.id })
		})),
		{ id: TOTAL, label: 'All gangs (each worker once)' }
	]);
	function value(id: string, day: string) {
		if (id === TOTAL) return view.dayTotals[day] ?? null;
		return view.cells[`${id}|${day}`]?.people ?? null;
	}
	const held = (id: string, day: string) => Boolean(view.cells[`${id}|${day}`]?.held);
</script>

<div data-testid="gang-grid">
	<AttendanceCalendarGrid
		{days}
		{entities}
		mode="count"
		entityLabel="Gang"
		cellValue={value}
		heldCell={held}
	/>
	<p class="gang-grid-note">
		Number = workers of the gang counted that day. <b class="swatch" aria-hidden="true"></b> Amber = the
		shift start was away from the pump and is waiting for approval or was rejected; it is not in the total.
	</p>
</div>

<style>
	.gang-grid-note {
		margin: var(--space-2) 0 0;
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}
	.swatch {
		display: inline-block;
		width: 0.9rem;
		height: 0.9rem;
		vertical-align: -2px;
		background: #ffe3a3;
		border: 1px solid var(--brand-mist);
		border-radius: 3px;
	}
</style>
