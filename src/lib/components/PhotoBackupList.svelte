<script lang="ts">
	import { resolve } from '$app/paths';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { formatDate } from '$lib/date';
	import { shiftTypeLabel } from '$lib/shiftLabels';
	import type { PhotoBackup } from '$lib/server/photoBackups';

	let { items, showPumpLink = false } = $props<{
		items: PhotoBackup[];
		showPumpLink?: boolean;
	}>();

	let filter = $state<'all' | 'failed' | 'fraud'>('all');
	let failedCount = $derived(items.filter((item: PhotoBackup) => item.status !== 'fraud').length);
	let fraudCount = $derived(items.length - failedCount);
	let shown = $derived(
		filter === 'all'
			? items
			: items.filter((item: PhotoBackup) => (item.status === 'fraud') === (filter === 'fraud'))
	);

	function photoUrl(id: string) {
		return resolve('/api/attendance/backup/[id]', { id });
	}

	function statusLabel(item: PhotoBackup) {
		if (item.status === 'fraud') return 'Fraud';
		if (item.status === 'failed') return 'Failed';
		return 'Never processed';
	}
</script>

{#if items.length}
	<div class="filters" role="group" aria-label="Show">
		<button type="button" class:active={filter === 'all'} onclick={() => (filter = 'all')}
			>All ({items.length})</button
		>
		<button type="button" class:active={filter === 'failed'} onclick={() => (filter = 'failed')}
			>Failed ({failedCount})</button
		>
		<button type="button" class:active={filter === 'fraud'} onclick={() => (filter = 'fraud')}
			>Fraud ({fraudCount})</button
		>
	</div>

	<ul class="backup-list scroll-box">
		{#each shown as item (item.id)}
			<li>
				<a class="thumb" href={photoUrl(item.id)} target="_blank" rel="noopener">
					<img src={photoUrl(item.id)} alt="Photo sent by {item.pump_code}" loading="lazy" />
				</a>
				<div class="copy">
					<div class="title">
						{#if showPumpLink}
							<a href={resolve('/admin/pumps/[id]', { id: item.pump_id })}>{item.pump_code}</a>
						{:else}
							<strong>{item.pump_code}</strong>
						{/if}
						<StatusBadge
							tone={item.status === 'fraud' ? 'critical' : 'attention'}
							label={statusLabel(item)}
						/>
					</div>
					<span class="muted">{item.plant_name} · {item.area_name}</span>
					<span>{shiftTypeLabel(item.session_type)} · {formatDate(item.session_date)}</span>
					<span class="muted">Sent {item.uploaded_at}</span>
					{#if item.reason}<span class="reason">{item.reason}</span>{/if}
					{#if item.error_detail && item.error_detail !== item.reason}
						<small class="muted detail">{item.error_detail}</small>
					{/if}
					{#if !item.session_id}
						<small class="muted"
							>The attendance entry was retried or deleted. Only this copy is left.</small
						>
					{/if}
				</div>
			</li>
		{/each}
	</ul>
{:else}
	<EmptyState
		title="No kept photos"
		description="Every photo so far was processed. Photos that fail or are flagged as fraud appear here."
	/>
{/if}

<style>
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-bottom: var(--space-3);
	}
	.filters button {
		padding: var(--space-1) var(--space-3);
		font: inherit;
		color: var(--ink-default);
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: 999px;
		cursor: pointer;
	}
	.filters button.active {
		color: var(--brand-white);
		background: var(--brand-teal);
		border-color: var(--brand-teal);
	}
	.backup-list {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.backup-list li {
		display: flex;
		gap: var(--space-3);
		padding: var(--space-3);
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.thumb {
		flex: none;
		width: 6rem;
		height: 6rem;
		overflow: hidden;
		background: var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.thumb img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.copy {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
		align-content: start;
	}
	.title {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	.muted {
		color: var(--ink-muted);
	}
	.reason {
		font-weight: 600;
		color: var(--ink-strong);
	}
	.detail {
		overflow-wrap: anywhere;
	}
</style>
