<script lang="ts">
	let { data } = $props();
</script>

<div class="wrap">
	<h1>Flagged Guests</h1>
	<div class="grid" data-testid="flagged-guests-grid">
		{#each data.guests as g}
			<div class="card">
				{#if g.face_crop_url}<img src={g.face_crop_url} alt="face crop" />{/if}
				<form method="POST" action="?/promote">
					<input type="hidden" name="id" value={g.id} />
					<button type="submit">Promote to Person</button>
				</form>
				<form method="POST" action="?/dismiss">
					<input type="hidden" name="id" value={g.id} />
					<button type="submit">Dismiss</button>
				</form>
			</div>
		{/each}
	</div>
</div>

<style>
	.wrap { max-width: 900px; margin: 2rem auto; font-family: sans-serif; }
	.grid { display: flex; flex-wrap: wrap; gap: 1rem; }
	.card { border: 1px solid #ddd; padding: 0.5rem; border-radius: 6px; }
	img { max-width: 120px; display: block; margin-bottom: 0.5rem; }
</style>
