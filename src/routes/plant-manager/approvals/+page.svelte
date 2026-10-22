<script lang="ts">
	import { resolve } from '$app/paths';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import FraudWatchList from '$lib/components/FraudWatchList.svelte';
	import { formatDate } from '$lib/date';

	let { data } = $props();
</script>

<svelte:head><title>Approvals | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Plant manager</p>
			<h1>Approvals</h1>
			<p>
				Shift starts where the operator was more than 100 m from the pump, or the location could not
				be checked. They are not counted in reports until you approve them.
			</p>
		</div>
	</header>

	{#if data.fraud.length}
		<FraudWatchList cases={data.fraud} testId="pm-fraud" />
	{/if}

	<section class="panel">
		<h2>Waiting for you ({data.pending.length})</h2>
		{#if data.pending.length}
			<ul class="approval-list scroll-box">
				{#each data.pending as item (item.id)}
					<li>
						<a href={resolve('/plant-manager/approvals/[id]', { id: item.id })}>
							<span class="approval-icon"><MapPin size={18} /></span>
							<span class="approval-copy">
								<strong>{item.pump_code} · {item.plant_name}</strong>
								<span>{item.reason}</span>
								<small>Shift {formatDate(item.session_date)} · photo sent {item.sent_at}</small>
							</span>
							<span class="button button--primary">Review</span>
						</a>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="empty">Nothing is waiting. Every shift start was within 100 m of its pump.</p>
		{/if}
	</section>

	{#if data.decided.length}
		<section class="panel">
			<h2>Decided in the last 30 days</h2>
			<div class="table-wrap">
				<table class="data-table">
					<thead>
						<tr><th>Pump</th><th>Shift</th><th>Problem</th><th>Decision</th><th>Note</th></tr>
					</thead>
					<tbody>
						{#each data.decided as item (item.id)}
							<tr>
								<td>
									<a href={resolve('/plant-manager/approvals/[id]', { id: item.id })}
										>{item.pump_code}</a
									>
								</td>
								<td>{formatDate(item.session_date)}</td>
								<td>{item.reason}</td>
								<td>
									<span
										class="status-badge"
										class:status-badge--success={item.location_status === 'approved'}
										class:status-badge--critical={item.location_status === 'rejected'}
										>{item.location_status === 'approved' ? 'Approved' : 'Rejected'}</span
									>
									<small class="muted">{item.decided_by ?? ''} · {item.decided_at}</small>
								</td>
								<td>{item.location_note ?? ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}
</div>

<style>
	.panel {
		margin-top: var(--space-5);
		padding: var(--space-5);
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-lg);
	}
	.panel h2 {
		margin: 0 0 var(--space-3);
		font-size: var(--text-lg);
	}
	.approval-list {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.approval-list a {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3);
		color: inherit;
		text-decoration: none;
		background: #fff8e6;
		border: 1px solid #f0d48a;
		border-radius: var(--radius-md);
	}
	.approval-icon {
		display: grid;
		flex: none;
		width: 2.25rem;
		height: 2.25rem;
		place-items: center;
		color: #8a5a00;
		background: #ffe9b0;
		border-radius: var(--radius-md);
	}
	.approval-copy {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
	}
	.approval-copy small,
	.muted {
		display: block;
		color: var(--ink-muted);
	}
	.empty {
		margin: 0;
		color: var(--ink-muted);
	}
	@media (max-width: 30rem) {
		.approval-list a {
			flex-wrap: wrap;
		}
		.approval-list .button {
			width: 100%;
			justify-content: center;
		}
	}
</style>
