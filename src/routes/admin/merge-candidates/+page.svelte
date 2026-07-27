<script lang="ts">
	let { data } = $props();
</script>

<div class="wrap">
	<h1>Merge Candidates</h1>
	<div data-testid="merge-candidates-list">
		{#each data.candidates as c}
			<div class="card">
				<p>Person {c.person_a.slice(0, 8)} vs {c.person_b.slice(0, 8)} — similarity {Number(c.similarity).toFixed(3)}</p>
				<form method="POST" action="?/confirm">
					<input type="hidden" name="kept" value={c.person_a} />
					<input type="hidden" name="merged" value={c.person_b} />
					<input type="hidden" name="similarity" value={c.similarity} />
					<button type="submit">Confirm Merge</button>
				</form>
			</div>
		{/each}
	</div>
</div>

<style>
	.wrap { max-width: 900px; margin: 2rem auto; font-family: sans-serif; }
	.card { border: 1px solid #ddd; padding: 0.75rem; border-radius: 6px; margin-bottom: 0.5rem; }
</style>
