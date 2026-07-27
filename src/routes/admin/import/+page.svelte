<script lang="ts">
	import Download from '@lucide/svelte/icons/download';
	import FileCheck from '@lucide/svelte/icons/file-check';
	import FileUp from '@lucide/svelte/icons/file-up';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Upload from '@lucide/svelte/icons/upload';
	import X from '@lucide/svelte/icons/x';

	const REQUIRED_HEADERS = ['Area Name', 'Plant Name', 'PUMP Name', 'Vendor Name'];
	let fileInput: HTMLInputElement;
	let selectedFile = $state<File | null>(null);
	let result = $state<any>(null);
	let error = $state('');
	let isDragging = $state(false);
	let isSubmitting = $state(false);

	async function selectFile(file: File | undefined) {
		error = '';
		result = null;
		if (!file) return;
		if (!file.name.toLowerCase().endsWith('.csv')) {
			error = 'Choose a file with a .csv extension.';
			return;
		}
		if (file.size > 5 * 1024 * 1024) {
			error = 'The CSV file must be 5 MB or smaller.';
			return;
		}

		const firstLine = (await file.slice(0, 2048).text()).split(/\r?\n/, 1)[0];
		const headers = firstLine.split(',').map((value) => value.trim().replace(/^"|"$/g, ''));
		const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
		if (missing.length) {
			error = `Missing required headers: ${missing.join(', ')}.`;
			return;
		}
		selectedFile = file;
	}

	function onInput(event: Event) {
		selectFile((event.currentTarget as HTMLInputElement).files?.[0]);
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		isDragging = false;
		selectFile(event.dataTransfer?.files?.[0]);
	}

	function clearFile() {
		selectedFile = null;
		result = null;
		error = '';
		if (fileInput) fileInput.value = '';
	}

	async function submit() {
		if (!selectedFile) return;
		error = '';
		isSubmitting = true;
		const form = new FormData();
		form.append('file', selectedFile);
		try {
			const res = await fetch('/api/admin/import/csv', { method: 'POST', body: form });
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				error = body.error || 'The import could not be completed.';
				return;
			}
			result = body;
		} catch {
			error = 'The service is not reachable. Your file is still selected.';
		} finally {
			isSubmitting = false;
		}
	}
</script>

<svelte:head><title>CSV import | Face Attendance</title></svelte:head>

<div class="page import-page">
	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Administration</p>
			<h1>CSV structure import</h1>
			<p>
				Import areas, plants, vendors, and pumps. Valid rows can be imported again without
				duplicating pumps.
			</p>
		</div>
		<a class="button button--secondary" href="/import-template.csv" download
			><Download size={17} /> Download template</a
		>
	</header>

	<section class="surface surface--padded">
		<input
			class="visually-hidden"
			bind:this={fileInput}
			type="file"
			accept=".csv,text/csv"
			onchange={onInput}
			data-testid="csv-file-input"
		/>

		{#if selectedFile}
			<div class="selected-file">
				<span class="file-icon"><FileCheck size={25} /></span>
				<div>
					<strong>{selectedFile.name}</strong><small
						>{(selectedFile.size / 1024).toFixed(1)} KB · Headers validated</small
					>
				</div>
				<button
					class="icon-button"
					type="button"
					onclick={clearFile}
					aria-label="Remove selected CSV"
					title="Remove file"><X size={19} /></button
				>
			</div>
		{:else}
			<button
				class:dragging={isDragging}
				class="upload-zone"
				type="button"
				onclick={() => fileInput?.click()}
				ondragover={(event) => {
					event.preventDefault();
					isDragging = true;
				}}
				ondragleave={() => (isDragging = false)}
				ondrop={onDrop}
			>
				<span class="file-icon"><FileUp size={26} /></span>
				<strong>Drop a CSV here or choose a file</strong>
				<small>Required: Area Name, Plant Name, PUMP Name, Vendor Name · 5 MB maximum</small>
			</button>
		{/if}

		{#if error}<p class="alert alert--error" role="alert">{error}</p>{/if}

		<div class="import-action">
			<button
				class="button button--primary"
				type="button"
				onclick={submit}
				disabled={!selectedFile || isSubmitting}
				data-testid="csv-import-submit"
			>
				{#if isSubmitting}<LoaderCircle class="spin" size={18} />{:else}<Upload size={18} />{/if}
				{isSubmitting ? 'Importing...' : 'Import CSV'}
			</button>
		</div>
	</section>

	{#if result}
		<section class="section" data-testid="import-summary">
			<div class="section-header">
				<div>
					<h2>Import complete</h2>
					<p class="supporting-text">{selectedFile?.name}</p>
				</div>
			</div>
			<div class="summary-list">
				<div><span>Rows processed</span><strong>{result.rows_total}</strong></div>
				<div><span>Rows created or updated</span><strong>{result.rows_created}</strong></div>
				<div><span>Rows skipped</span><strong>{result.rows_skipped}</strong></div>
				<div><span>Areas created</span><strong>{result.areas_created}</strong></div>
				<div><span>Plants created</span><strong>{result.plants_created}</strong></div>
				<div><span>Vendors created</span><strong>{result.vendors_created}</strong></div>
				<div><span>Pumps created</span><strong>{result.pumps_created}</strong></div>
				<div><span>Pumps updated</span><strong>{result.pumps_updated}</strong></div>
			</div>

			{#if result.errors?.length}
				<div class="section-header errors-heading">
					<h2>Row errors</h2>
					<span>{result.errors.length}</span>
				</div>
				<div class="table-wrap error-table">
					<table class="data-table">
						<thead><tr><th>Row</th><th>Message</th></tr></thead><tbody
							>{#each result.errors as item}<tr><td>{item.row}</td><td>{item.message}</td></tr
								>{/each}</tbody
						>
					</table>
				</div>
			{/if}
		</section>
	{/if}
</div>

<style>
	.import-page {
		max-width: 58rem;
	}
	.eyebrow {
		margin: 0 0 var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
	}
	.upload-zone {
		display: grid;
		width: 100%;
		min-height: 15rem;
		place-items: center;
		align-content: center;
		gap: var(--space-2);
		padding: var(--space-6);
		color: var(--ink-default);
		background: var(--surface-subtle);
		border: 1px dashed var(--brand-steel);
		border-radius: var(--radius-md);
		cursor: pointer;
	}
	.upload-zone:hover,
	.upload-zone.dragging {
		background: var(--primary-tint);
		border-color: var(--brand-teal);
	}
	.upload-zone small,
	.selected-file small {
		color: var(--ink-muted);
	}
	.file-icon {
		display: grid;
		width: 3rem;
		height: 3rem;
		place-items: center;
		color: var(--brand-teal);
		background: var(--primary-tint);
		border-radius: var(--radius-md);
	}
	.selected-file {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-4);
		background: var(--surface-subtle);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.selected-file div {
		display: grid;
		min-width: 0;
	}
	.selected-file strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.alert {
		margin-top: var(--space-4);
	}
	.import-action {
		display: flex;
		justify-content: flex-end;
		margin-top: var(--space-4);
	}
	.summary-list {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.summary-list div {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--brand-mist);
		border-width: 0 1px 1px 0;
	}
	.summary-list span {
		color: var(--ink-muted);
	}
	.summary-list strong {
		font-size: var(--text-lg);
		font-variant-numeric: tabular-nums;
	}
	.errors-heading {
		margin-top: var(--space-6);
	}
	.error-table {
		max-height: 24rem;
	}
	:global(.spin) {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
