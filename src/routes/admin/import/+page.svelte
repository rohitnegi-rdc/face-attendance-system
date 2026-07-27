<script lang="ts">
	let fileInput: HTMLInputElement;
	let result = $state<any>(null);
	let error = $state('');

	async function submit(e: Event) {
		e.preventDefault();
		error = '';
		const file = fileInput.files?.[0];
		if (!file) return;
		const form = new FormData();
		form.append('file', file);
		const res = await fetch('/api/admin/import/csv', { method: 'POST', body: form });
		const body = await res.json();
		if (!res.ok) {
			error = body.error;
			return;
		}
		result = body;
	}
</script>

<div class="wrap">
	<h1>CSV Bulk Import</h1>
	<form onsubmit={submit}>
		<input bind:this={fileInput} type="file" accept=".csv" data-testid="csv-file-input" />
		<button type="submit" data-testid="csv-import-submit">Import</button>
	</form>

	{#if error}<p class="error">{error}</p>{/if}

	{#if result}
		<div data-testid="import-summary">
			<p>Rows total: {result.rows_total}, created: {result.rows_created}, skipped: {result.rows_skipped}</p>
			<p>
				Areas created: {result.areas_created}, Plants created: {result.plants_created}, Vendors created:
				{result.vendors_created}, Pumps created: {result.pumps_created}, Pumps updated: {result.pumps_updated}
			</p>
			{#if result.errors?.length}
				<ul>
					{#each result.errors as e}
						<li>Row {e.row}: {e.message}</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

<style>
	.wrap {
		max-width: 700px;
		margin: 2rem auto;
		font-family: sans-serif;
	}
	.error {
		color: #c0392b;
	}
</style>
