<script lang="ts">
	// The same Fix attendance as the admin's (FixAttendance.svelte), for the manager's plants. Back
	// returns where it was opened from: ?from=overview Pumps today, ?from=pump the pump's day,
	// otherwise Attendance. ?via=pumps: the pump's day was opened from the Pumps page.
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import FixAttendance from '$lib/components/FixAttendance.svelte';
	import { todayStr } from '$lib/date';

	let { data, form } = $props();

	const from = $derived(page.url.searchParams.get('from'));
	const isToday = $derived(data.day === todayStr());
	// The pump's day keeps where it was opened from (?via=pumps: the Pumps page).
	const pumpDayQuery = $derived.by(() => {
		const params = new URLSearchParams();
		if (!isToday) params.set('day', data.day);
		if (page.url.searchParams.get('via') === 'pumps') params.set('from', 'pumps');
		const query = params.toString();
		return query ? `?${query}` : '';
	});
	const back = $derived(
		from === 'overview'
			? {
					href: resolve('/plant-manager') + (isToday ? '' : `?day=${data.day}`),
					label: isToday ? 'Pumps today' : 'Pumps yesterday'
				}
			: from === 'pump'
				? {
						href: resolve('/plant-manager/pumps/[id]', { id: data.pump.id }) + pumpDayQuery,
						label: data.pump.pump_code
					}
				: { href: resolve('/plant-manager/attendance'), label: 'Attendance' }
	);
</script>

<FixAttendance {data} {form} backHref={back.href} backLabel={back.label} />
