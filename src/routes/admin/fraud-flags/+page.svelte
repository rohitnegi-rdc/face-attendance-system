<script lang="ts">
	import { formatDate } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';

	let { data } = $props();
</script>

<div class="wrap">
	<h1>Fraud Flags</h1>
	<table data-testid="fraud-flags-table">
		<thead><tr><th>Date</th><th>Person</th><th>Flagged At Pump</th><th>Matched At Pump</th><th>Similarity</th><th>Reviewed</th><th></th></tr></thead>
		<tbody>
			{#each data.flags as f}
				<tr>
					<td>{formatDate(f.created_at)}</td>
					<td>{personDisplayLabel(f.matched_at_pump, f.display_seq)}</td>
					<td>{f.flagged_at_pump}</td>
					<td>{f.matched_at_pump}</td>
					<td>{Number(f.similarity_score).toFixed(3)}</td>
					<td>{f.reviewed ? 'Yes' : 'No'}</td>
					<td>
						{#if !f.reviewed}
							<form method="POST" action="?/review">
								<input type="hidden" name="id" value={f.id} />
								<button type="submit">Mark Reviewed</button>
							</form>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.wrap { max-width: 900px; margin: 2rem auto; font-family: sans-serif; }
	table { width: 100%; border-collapse: collapse; }
	th, td { border: 1px solid #ddd; padding: 0.3rem 0.5rem; }
</style>
