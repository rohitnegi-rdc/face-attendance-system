<script lang="ts">
	import { resolve } from '$app/paths';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import MetricStrip from '$lib/components/MetricStrip.svelte';

	let { data } = $props();

	const logsPath = resolve('/admin/logs');

	// Every line of one photo (app, worker, AI failures) shares its request id.
	function traceHref(id: string) {
		return `${logsPath}?days=30&q=${encodeURIComponent(id)}`;
	}

	function hasDetails(details: Record<string, unknown>) {
		return Object.keys(details ?? {}).length > 0;
	}
</script>

<svelte:head><title>Logs | Face Attendance</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Platform operations</p>
			<h1>Logs</h1>
			<p>
				Warnings and errors from the app and the worker in one place, newest first. Face service
				failures show up here through the worker, under the same request id. Kept for 30 days.
			</p>
		</div>
	</header>

	<MetricStrip
		testId="log-counts"
		metrics={[
			{ label: 'Errors, last 24 hours', value: data.counts.errors },
			{ label: 'Warnings, last 24 hours', value: data.counts.warnings }
		]}
	/>

	<form class="filter-bar" method="GET">
		<label class="field"
			><span>Level</span><select name="level"
				><option value="">Warnings and errors</option><option
					value="error"
					selected={data.filters.level === 'error'}>Errors only</option
				><option value="warn" selected={data.filters.level === 'warn'}>Warnings only</option
				></select
			></label
		>
		<label class="field"
			><span>Service</span><select name="service"
				><option value="">All services</option><option
					value="app"
					selected={data.filters.service === 'app'}>App (website)</option
				><option value="worker" selected={data.filters.service === 'worker'}
					>Worker (photo processing)</option
				></select
			></label
		>
		<label class="field"
			><span>Period</span><select name="days"
				><option value="1" selected={data.filters.days === 1}>Last 24 hours</option><option
					value="7"
					selected={data.filters.days === 7}>Last 7 days</option
				><option value="30" selected={data.filters.days === 30}>Last 30 days</option></select
			></label
		>
		<label class="field"
			><span>Search</span><input
				name="q"
				type="search"
				value={data.filters.q}
				placeholder="Pump code, message, request id"
			/></label
		>
		<div class="filter-actions">
			<button class="button button--primary" type="submit">Filter</button>
			<a class="button button--ghost" href={logsPath}>Reset</a>
		</div>
	</form>

	{#if data.lines.length}
		<p class="muted" data-testid="log-total">
			{data.lines.length === data.limit
				? `Newest ${data.limit} lines. Narrow the filters to see older ones.`
				: `${data.lines.length} ${data.lines.length === 1 ? 'line' : 'lines'}`}
		</p>
		<ul class="log-list scroll-box" data-testid="log-list">
			{#each data.lines as line (line.id)}
				<li class="log-line" class:log-line--error={line.level !== 'warn'}>
					<div class="log-head">
						<StatusBadge
							tone={line.level === 'warn' ? 'attention' : 'critical'}
							label={line.level === 'warn' ? 'Warning' : 'Error'}
						/>
						<span class="log-service">{line.service}</span>
						<time>{line.logged_at}</time>
					</div>
					<p class="log-message">{line.message}</p>
					{#if line.pump_code || line.request_id || line.session_id}
						<div class="log-refs">
							{#if line.pump_code}<span>Pump <strong>{line.pump_code}</strong></span>{/if}
							{#if line.request_id}
								<a href={traceHref(line.request_id)} title="Show every line for this photo"
									>Request {line.request_id.slice(0, 8)}</a
								>
							{/if}
							{#if line.session_id}
								<a href={traceHref(line.session_id)} title="Show every line for this session"
									>Session {line.session_id.slice(0, 8)}</a
								>
							{/if}
						</div>
					{/if}
					{#if hasDetails(line.details)}
						<details>
							<summary>Details</summary>
							<pre>{JSON.stringify(line.details, null, 2)}</pre>
						</details>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<EmptyState
			title="No warnings or errors"
			description="Nothing matches these filters. That is good news."
		/>
	{/if}
</div>

<style>
	.log-list {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.log-line {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-left: 4px solid var(--brand-steel);
		border-radius: var(--radius-md);
	}

	.log-line--error {
		border-left-color: var(--ink-strong);
	}

	.log-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.log-service {
		color: var(--ink-muted);
		font-size: var(--text-sm);
		font-weight: 600;
	}

	.log-head time {
		margin-left: auto;
		color: var(--ink-muted);
		font-size: var(--text-sm);
		font-variant-numeric: tabular-nums;
	}

	.log-message {
		margin: 0;
		color: var(--ink-strong);
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.log-refs {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		font-size: var(--text-sm);
	}

	details summary {
		color: var(--ink-muted);
		font-size: var(--text-sm);
		cursor: pointer;
	}

	pre {
		max-height: 16rem;
		margin: var(--space-2) 0 0;
		padding: var(--space-3);
		overflow: auto;
		font-size: var(--text-xs);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		background: var(--surface-muted);
		border-radius: var(--radius-sm);
	}
</style>
