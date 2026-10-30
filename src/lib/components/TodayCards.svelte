<script lang="ts">
	// Today's attendance as one card per area or plant (admin Overview, Areas, Plants, area page):
	// name and percentage present, a bar, then present of recorded and pumps reported. A card with
	// fraud today turns red. Cards sit side by side to compare; one column on a phone.
	import ChevronRight from '@lucide/svelte/icons/chevron-right';

	export type TodayCard = {
		id: string;
		// Without a link (the plant's own page) the card is plain.
		href?: string;
		name: string;
		sub?: string | null;
		pct: number;
		present: number;
		total: number;
		reporting: number;
		pumps: number;
		fraud: number;
	};

	let {
		items,
		bounded = false,
		testId = 'today-cards'
	}: {
		items: TodayCard[];
		// A fixed-height list that scrolls inside itself (Overview), so many cards never push the
		// rest of the page down.
		bounded?: boolean;
		testId?: string;
	} = $props();
</script>

<ul class="card-grid" class:card-grid--bounded={bounded} data-testid={testId}>
	{#each items as item (item.id)}
		<li>
			<svelte:element
				this={item.href ? 'a' : 'div'}
				class="card"
				class:card--link={item.href}
				class:card--fraud={item.fraud > 0}
				href={item.href}
				data-testid="today-card"
			>
				<span class="card__top">
					<span class="card__name">
						<strong>{item.name}</strong>
						{#if item.sub}<small>{item.sub}</small>{/if}
					</span>
					<strong class="card__pct">{item.pct}%</strong>
					{#if item.href}<ChevronRight size={16} />{/if}
				</span>
				<span class="card__track" aria-hidden="true"
					><span style={`width: ${item.pct}%`}></span></span
				>
				<span class="card__foot">
					<span><strong>{item.present}</strong> of {item.total} present</span>
					<span>{item.reporting} of {item.pumps} {item.pumps === 1 ? 'pump' : 'pumps'}</span>
					{#if item.fraud}<span class="card__fraud">{item.fraud} fraud</span>{/if}
				</span>
			</svelte:element>
		</li>
	{/each}
</ul>

<style>
	.card-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.card-grid--bounded {
		max-height: 22rem;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.card {
		display: grid;
		gap: var(--space-2);
		height: 100%;
		padding: var(--space-3);
		color: var(--ink-default);
		text-decoration: none;
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.card--link:hover {
		border-color: var(--brand-teal);
	}
	.card--fraud {
		background: var(--alert-tint);
		border-color: var(--alert);
	}
	.card__top {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--ink-strong);
	}
	.card__name {
		display: grid;
		flex: 1;
		min-width: 0;
	}
	.card__name strong,
	.card__name small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.card__name small {
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}
	.card__pct {
		font-size: var(--text-lg);
		font-variant-numeric: tabular-nums;
	}
	.card__top :global(svg) {
		flex: 0 0 auto;
		color: var(--ink-muted);
	}
	.card__track {
		height: 0.375rem;
		overflow: hidden;
		background: var(--surface-muted);
		border-radius: var(--radius-sm);
	}
	.card__track span {
		display: block;
		height: 100%;
		background: var(--brand-teal);
	}
	.card__foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-3);
		color: var(--ink-muted);
		font-size: var(--text-sm);
		font-variant-numeric: tabular-nums;
	}
	.card__foot strong {
		color: var(--ink-strong);
	}
	.card__fraud {
		margin-left: auto;
		padding: 0.1rem 0.5rem;
		color: var(--surface-raised);
		font-weight: 700;
		background: var(--alert);
		border-radius: 999px;
	}
</style>
