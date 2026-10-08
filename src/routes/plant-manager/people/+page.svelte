<script lang="ts">
	import Search from '@lucide/svelte/icons/search';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { formatDate } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';
	let { data } = $props();
</script>
<svelte:head><title>Plant workers | Face Attendance</title></svelte:head>
<div class="page"><header class="page-header"><div class="page-header__copy"><p class="eyebrow">Plant manager</p><h1>People</h1><p>Recognized workers at your assigned plants.</p></div></header>
	<form class="filter-bar compact-filter" method="GET"><label class="field"><span>Pump</span><select name="pump"><option value="">All pumps</option>{#each data.pumps as pump}<option value={pump.id} selected={pump.id === data.pump}>{pump.pump_code}</option>{/each}</select></label><div class="filter-actions"><button class="button button--primary" type="submit"><Search size={17} /> Apply</button></div></form>
	{#if data.persons.length}<div class="table-wrap"><table class="data-table"><thead><tr><th>Person</th><th>Pump</th><th>First seen</th><th>Last seen</th><th>Full shift</th><th>Start only</th><th>End only</th></tr></thead><tbody>{#each data.persons as person}<tr><td><span class="person-cell">{#if person.source_photo_crop_url}<img src={person.source_photo_crop_url} alt="" loading="lazy" />{:else}<span class="crop-placeholder"></span>{/if}<strong>{personDisplayLabel(person.pump_code, person.display_seq)}</strong></span></td><td>{person.pump_code}</td><td>{formatDate(person.first_seen_at)}</td><td>{formatDate(person.last_seen_at)}</td><td>{person.days_present}</td><td>{person.days_morning_only}</td><td>{person.days_evening_only}</td></tr>{/each}</tbody></table></div>{:else}<EmptyState title="No people found" description="Workers will appear after attendance sessions have been processed." />{/if}
</div>
<style>
	.eyebrow { margin: 0 0 var(--space-1); color: var(--ink-muted); font-size: var(--text-xs); font-weight: 700; text-transform: uppercase; }
	.compact-filter { grid-template-columns: minmax(12rem, 20rem) auto; justify-content: start; }
	.person-cell { display: inline-flex; align-items: center; gap: var(--space-2); white-space: nowrap; }
	.person-cell img, .crop-placeholder { width: 2.5rem; height: 2.5rem; object-fit: cover; background: var(--surface-muted); border-radius: var(--radius-sm); }
	@media (max-width: 36rem) { .compact-filter { grid-template-columns: 1fr; } }
</style>
