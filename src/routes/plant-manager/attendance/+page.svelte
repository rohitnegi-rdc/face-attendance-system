<script lang="ts">
	import { resolve } from '$app/paths';
	import Search from '@lucide/svelte/icons/search';
	import AttendanceCalendarGrid from '$lib/components/AttendanceCalendarGrid.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { dateKey, formatDate } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';
	let { data } = $props();
	const days = $derived([...new Set(data.daily.map((row: any) => dateKey(row.session_date)))].sort());
	const entities = $derived(data.pumps.map((pump: any) => ({ id: pump.id, label: pump.pump_code })));
	const lookup = $derived(new Map(data.daily.map((row: any) => [`${row.pump_id}:${dateKey(row.session_date)}`, Number(row.attendance_pct)])));
</script>

<svelte:head><title>Plant attendance | Face Attendance</title></svelte:head>
<div class="page">
	<header class="page-header"><div class="page-header__copy"><p class="eyebrow">Plant manager</p><h1>Attendance</h1><p>Attendance and session evidence for your assigned plants.</p></div></header>
	<form class="filter-bar compact-filter" method="GET"><label class="field"><span>From</span><input type="date" name="from" value={data.filters.from} /></label><label class="field"><span>To</span><input type="date" name="to" value={data.filters.to} /></label><div class="filter-actions"><button class="button button--primary" type="submit"><Search size={17} /> Apply</button></div></form>
	<section class="section"><div class="section-header"><div><h2>Daily attendance</h2><p class="supporting-text">Complete morning and evening matches by pump.</p></div></div>
		{#if days.length}<AttendanceCalendarGrid {days} {entities} mode="percent" cellValue={(entity, day) => lookup.get(`${entity}:${day}`) ?? null} />{:else}<EmptyState title="No attendance in this range" description="Choose another date range." />{/if}
	</section>
	<section class="section"><div class="section-header"><div><h2>Person records</h2><p class="supporting-text">{data.records.length} records shown</p></div></div>
		{#if data.records.length}<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Person</th><th>Pump</th><th>Plant</th><th>Morning</th><th>Evening</th></tr></thead><tbody>{#each data.records as row}<tr><td>{formatDate(row.session_date)}</td><td>{personDisplayLabel(row.pump_code, row.display_seq)}</td><td>{row.pump_code}</td><td>{row.plant_name}</td><td><StatusBadge tone={row.morning_matched ? 'success' : 'neutral'} label={row.morning_matched ? 'Present' : 'Missing'} /></td><td><StatusBadge tone={row.evening_matched ? 'success' : 'neutral'} label={row.evening_matched ? 'Present' : 'Missing'} /></td></tr>{/each}</tbody></table></div>{:else}<EmptyState title="No person records" description="Attendance records will appear here after sessions are processed." />{/if}
	</section>
	<section class="section"><div class="section-header"><div><h2>Session log and photos</h2><p class="supporting-text">{data.sessions.length} sessions shown</p></div></div>
		{#if data.sessions.length}<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Plant</th><th>Pump</th><th>Session</th><th>Submitted</th><th>Status</th><th>Photo</th></tr></thead><tbody>{#each data.sessions as row}<tr><td>{formatDate(row.session_date)}</td><td>{row.plant_name}</td><td>{row.pump_code}</td><td>{row.session_type}</td><td>{formatDate(row.submitted_at)}</td><td><StatusBadge tone={row.status === 'completed' ? 'success' : row.status === 'failed' ? 'critical' : 'pending'} label={row.status} /></td><td>{#if row.photo_url}<a href={resolve(`/api/attendance/photo/${row.id}`)} target="_blank" rel="noreferrer">View photo</a>{:else}—{/if}</td></tr>{/each}</tbody></table></div>{:else}<EmptyState title="No sessions" description="Pump submissions will appear here." />{/if}
	</section>
</div>
<style>
	.eyebrow { margin: 0 0 var(--space-1); color: var(--ink-muted); font-size: var(--text-xs); font-weight: 700; text-transform: uppercase; }
	.supporting-text { margin: 0; color: var(--ink-muted); font-size: var(--text-sm); }
	.compact-filter { grid-template-columns: repeat(2, minmax(11rem, 16rem)) auto; justify-content: start; }
	@media (max-width: 38rem) { .compact-filter { grid-template-columns: 1fr; } }
</style>
