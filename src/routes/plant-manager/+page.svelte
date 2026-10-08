<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import MetricStrip from '$lib/components/MetricStrip.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { formatDate } from '$lib/date';
	let { data } = $props();
	const metrics = $derived([
		{ label: 'Assigned plants', value: data.plants.length },
		{ label: 'Pumps', value: data.summary.pump_count ?? 0 },
		{ label: 'Active people', value: data.summary.people_count ?? 0 },
		{ label: 'Open sessions today', value: data.summary.open_sessions ?? 0 }
	]);
</script>

<svelte:head><title>Plant manager overview | Face Attendance</title></svelte:head>
<div class="page">
	<header class="page-header"><div class="page-header__copy"><p class="eyebrow">Plant manager</p><h1>Overview</h1><p>Attendance activity for your assigned plants.</p></div><a class="button button--primary" href={resolve('/plant-manager/attendance')}>View attendance <ArrowRight size={17} /></a></header>
	<MetricStrip {metrics} />
	<section class="section"><div class="section-header"><div><h2>Your plants</h2><p class="supporting-text">Access is limited to plants assigned by an administrator.</p></div></div>
		{#if data.plants.length}<div class="table-wrap"><table class="data-table"><thead><tr><th>Plant</th><th>Area</th><th>Pumps</th><th>Sessions today</th></tr></thead><tbody>{#each data.plants as plant}<tr><td><strong>{plant.name}</strong></td><td>{plant.area_name}</td><td>{plant.pump_count}</td><td>{plant.sessions_today}</td></tr>{/each}</tbody></table></div>
		{:else}<EmptyState title="No plants assigned" description="Ask an administrator to assign a plant to your account." />{/if}
	</section>
	<section class="section"><div class="section-header"><div><h2>Recent attendance sessions</h2><p class="supporting-text">Latest submissions from your plants.</p></div></div>
		{#if data.recent.length}<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Plant</th><th>Pump</th><th>Session</th><th>Status</th><th>Evidence</th></tr></thead><tbody>{#each data.recent as row}<tr><td>{formatDate(row.session_date)}</td><td>{row.plant_name}</td><td>{row.pump_code}</td><td>{row.session_type}</td><td><StatusBadge tone={row.status === 'completed' ? 'success' : row.status === 'failed' ? 'critical' : 'pending'} label={row.status} /></td><td>{#if row.photo_url}<a href={resolve(`/api/attendance/photo/${row.id}`)} target="_blank" rel="noreferrer">View photo</a>{:else}—{/if}</td></tr>{/each}</tbody></table></div>
		{:else}<EmptyState title="No attendance sessions yet" description="Submitted sessions will appear here." />{/if}
	</section>
</div>
<style>
	.eyebrow { margin: 0 0 var(--space-1); color: var(--ink-muted); font-size: var(--text-xs); font-weight: 700; text-transform: uppercase; }
	.supporting-text { margin: 0; color: var(--ink-muted); font-size: var(--text-sm); }
</style>
