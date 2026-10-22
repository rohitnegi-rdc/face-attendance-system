<script lang="ts">
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

	// Open cross-pump fraud cases (listOpenFraud in src/lib/server/navCounts.ts), read only:
	// the plant manager and the vendor watch, the admin decides.
	type FraudCase = {
		id: string;
		face_crop_url: string | null;
		similarity_score: number | string;
		is_operator: boolean;
		flagged_at: string;
		flagged_pump: string;
		flagged_plant: string;
		matched_pump: string;
		matched_plant: string;
	};

	let { cases, testId = 'fraud-watch' }: { cases: FraudCase[]; testId?: string } = $props();
</script>

<section class="panel fraud-panel" data-testid={testId}>
	<h2><TriangleAlert size={20} /> Same person at two pumps ({cases.length})</h2>
	<p class="muted">
		The fraud check found a face already counted at another pump in this Area. That face is not
		counted again. An admin decides whether it is fraud.
	</p>
	{#if cases.length}
		<ul class="fraud-list scroll-box">
			{#each cases as item (item.id)}
				<li>
					{#if item.face_crop_url}<img
							src={item.face_crop_url}
							alt="Face found at two pumps"
						/>{/if}
					<span class="fraud-copy">
						<strong>{item.flagged_pump} · {item.flagged_plant}</strong>
						<span
							>Already counted at <strong>{item.matched_pump}</strong> ({item.matched_plant}), face
							match {Math.round(Number(item.similarity_score) * 100)}%{item.is_operator
								? ', operator photo'
								: ''}</span
						>
						<small>Found {item.flagged_at} · waiting for admin</small>
					</span>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="empty">No open cases. Nobody was found at two pumps.</p>
	{/if}
</section>

<style>
	.fraud-panel {
		border-left: 4px solid var(--alert);
	}
	.fraud-panel h2 {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0 0 var(--space-2);
		color: var(--alert);
		font-size: var(--text-lg);
	}
	.muted,
	.fraud-copy small {
		display: block;
		margin: 0;
		color: var(--ink-muted);
	}
	.fraud-list {
		display: grid;
		gap: var(--space-2);
		margin: var(--space-3) 0 0;
		padding: 0;
		list-style: none;
	}
	.fraud-list li {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3);
		background: var(--alert-tint);
		border: 1px solid var(--alert);
		border-radius: var(--radius-md);
	}
	.fraud-list img {
		flex: none;
		width: 3rem;
		height: 3rem;
		object-fit: cover;
		border-radius: var(--radius-sm);
	}
	.fraud-copy {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
	}
	.empty {
		margin: var(--space-3) 0 0;
		color: var(--ink-muted);
	}
</style>
