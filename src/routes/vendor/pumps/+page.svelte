<script lang="ts">
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate } from '$lib/date';
	let { data } = $props();
</script>

<svelte:head><title>Vendor pumps | Face Attendance</title></svelte:head>
<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Vendor workspace</p>
			<h1>Pumps</h1>
			<p>Submission state and 30-day performance for assigned pumps.</p>
		</div>
	</header>
	{#if data.pumps.length}
		<div class="table-wrap">
			<table class="data-table" data-testid="vendor-pumps-table">
				<thead
					><tr
						><th>Pump</th><th>Plant</th><th>Area</th><th>Latest submission</th><th>Session</th><th
							>Status</th
						><th>30-day attendance</th></tr
					></thead
				><tbody
					>{#each data.pumps as pump}<tr
							><td><strong>{pump.pump_code}</strong></td><td>{pump.plant_name}</td><td
								>{pump.area_name}</td
							><td
								>{pump.latest_submission
									? formatDate(pump.latest_submission)
									: 'No submissions'}</td
							><td>{pump.session_type || 'Not started'}</td><td
								><StatusBadge
									tone={pump.status === 'completed'
										? 'success'
										: pump.status === 'failed'
											? 'critical'
											: 'pending'}
									label={pump.status || 'Not started'}
								/></td
							><td>{pump.attendance_pct}%</td></tr
						>{/each}</tbody
				>
			</table>
		</div>
	{:else}<EmptyState
			title="No assigned pumps"
			description="Pumps assigned to this vendor will appear here."
		/>{/if}
</div>

<style>
	.eyebrow {
		margin: 0 0 var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
	}
</style>
