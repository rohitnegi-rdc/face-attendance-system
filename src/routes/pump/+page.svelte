<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import Camera from '@lucide/svelte/icons/camera';
	import Check from '@lucide/svelte/icons/check';
	import ImagePlus from '@lucide/svelte/icons/image-plus';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Upload from '@lucide/svelte/icons/upload';
	import Users from '@lucide/svelte/icons/users';
	import { personDisplayLabel } from '$lib/personLabel';

	type FlowStatus = 'idle' | 'submitting' | 'processing' | 'completed' | 'failed';

	let cameraInput: HTMLInputElement;
	let galleryInput: HTMLInputElement;
	let status = $state<FlowStatus>('idle');
	let errorMsg = $state('');
	let selectedFile = $state<File | null>(null);
	let previewUrl = $state('');
	let result = $state<any>(null);
	let today = $state<any>(null);
	let todayLoading = $state(true);
	let processingStep = $state(0);

	const processingLabels = ['Photo received', 'Detecting faces', 'Matching attendance'];

	onMount(loadToday);
	onDestroy(clearPreview);

	async function loadToday() {
		todayLoading = true;
		try {
			const res = await fetch('/api/attendance/today');
			if (res.ok) today = await res.json();
		} finally {
			todayLoading = false;
		}
	}

	function clearPreview() {
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrl = '';
	}

	function chooseFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		clearPreview();
		selectedFile = file;
		previewUrl = URL.createObjectURL(file);
		status = 'idle';
		errorMsg = '';
		result = null;
	}

	function resetCapture() {
		clearPreview();
		selectedFile = null;
		result = null;
		errorMsg = '';
		status = 'idle';
		if (cameraInput) cameraInput.value = '';
		if (galleryInput) galleryInput.value = '';
		loadToday();
	}

	async function submitPhoto() {
		if (!selectedFile) return;
		errorMsg = '';
		status = 'submitting';

		let lat = '';
		let lng = '';
		try {
			const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
				navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 })
			);
			lat = String(pos.coords.latitude);
			lng = String(pos.coords.longitude);
		} catch {
			// Location is helpful context, but capture remains available without it.
		}

		const form = new FormData();
		form.append('photo', selectedFile);
		if (lat) form.append('lat', lat);
		if (lng) form.append('lng', lng);

		try {
			const res = await fetch('/api/attendance/submit', { method: 'POST', body: form });
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				status = 'failed';
				errorMsg = body.error || 'The photo could not be submitted.';
				return;
			}

			status = 'processing';
			processingStep = 0;
			await poll(body.session_id);
		} catch {
			status = 'failed';
			errorMsg = 'The service is not reachable. Your selected photo is still ready to retry.';
		}
	}

	async function poll(sessionId: string) {
		let connectionFailures = 0;
		for (let i = 0; i < 90; i++) {
			await new Promise((resolve) => setTimeout(resolve, 2000));
			processingStep = Math.min(2, Math.floor(i / 3));
			try {
				const res = await fetch(`/api/attendance/status/${sessionId}`);
				if (!res.ok) throw new Error('status unavailable');
				const body = await res.json();
				connectionFailures = 0;
				if (body.status === 'completed') {
					status = 'completed';
					result = body;
					await loadToday();
					return;
				}
				if (body.status === 'failed') {
					status = 'failed';
					errorMsg = body.error_reason || 'Processing failed. Please try another photo.';
					return;
				}
			} catch {
				connectionFailures += 1;
				if (connectionFailures >= 5) {
					status = 'failed';
					errorMsg = 'The connection was interrupted while checking the result.';
					return;
				}
			}
		}
		status = 'failed';
		errorMsg = 'Processing is taking longer than expected. Please retry the status check.';
	}

	function sessionTitle() {
		if (today?.state === 'locked') return 'Attendance complete';
		if (today?.state === 'evening' && today?.can_submit === false)
			return 'Evening attendance scheduled';
		if (today?.state === 'evening') return 'Evening attendance';
		return 'Morning attendance';
	}

	function formatIST(value: string | null | undefined) {
		if (!value) return '';
		return new Intl.DateTimeFormat('en-IN', {
			dateStyle: 'medium',
			timeStyle: 'short',
			timeZone: 'Asia/Kolkata'
		}).format(new Date(value));
	}
</script>

<svelte:head>
	<title>Pump capture | Face Attendance</title>
</svelte:head>

<div class="capture-page">
	<header class="capture-heading">
		<div>
			<p class="eyebrow">Today’s session</p>
			<h1>{sessionTitle()}</h1>
			<p>
				{today?.pump_code ? `${today.pump_code} · ${today.plant_name}` : 'Group photo attendance'}
			</p>
		</div>
		{#if todayLoading}
			<span class="status-badge"><LoaderCircle class="spin" size={14} /> Checking</span>
		{:else if today?.state === 'locked'}
			<span class="status-badge status-badge--success"><Check size={14} /> Complete</span>
		{:else}
			<span class="status-badge">
				{today?.can_submit === false
					? 'Waiting'
					: `${today?.state === 'evening' ? 'Evening' : 'Morning'} open`}
			</span>
		{/if}
	</header>

	<div class="capture-layout">
		<section class="capture-workspace" aria-labelledby="photo-heading">
			<div class="section-heading">
				<div>
					<h2 id="photo-heading">Group photo</h2>
					<p>Keep every face visible and inside the frame.</p>
				</div>
			</div>

			<input
				class="visually-hidden"
				bind:this={cameraInput}
				type="file"
				accept="image/*"
				capture="environment"
				onchange={chooseFile}
				data-testid="capture-input"
			/>
			<input
				class="visually-hidden"
				bind:this={galleryInput}
				type="file"
				accept="image/*"
				onchange={chooseFile}
			/>

			{#if previewUrl}
				<div class="photo-preview">
					<img src={previewUrl} alt="Selected group attendance preview" />
					{#if status === 'submitting' || status === 'processing'}
						<div class="processing-overlay" aria-hidden="true">
							<LoaderCircle class="spin" size={30} />
						</div>
					{/if}
				</div>
				<div class="photo-meta">
					<span>{selectedFile?.name}</span>
					<span>{selectedFile ? `${(selectedFile.size / 1024 / 1024).toFixed(1)} MB` : ''}</span>
				</div>
			{:else}
				<div class="capture-empty">
					<span class="capture-icon"><Users size={34} strokeWidth={1.6} /></span>
					<strong>Ready for the team photo</strong>
					<p>Stand where the whole group is evenly lit and facing the camera.</p>
					<div class="capture-choices">
						<button
							class="button button--primary"
							type="button"
							onclick={() => cameraInput?.click()}
							disabled={today?.state === 'locked' || today?.can_submit === false}
						>
							<Camera size={18} /> Take photo
						</button>
						<button
							class="button button--secondary"
							type="button"
							onclick={() => galleryInput?.click()}
							disabled={today?.state === 'locked' || today?.can_submit === false}
						>
							<ImagePlus size={18} /> Choose photo
						</button>
					</div>
				</div>
			{/if}
		</section>

		<aside class="session-panel" aria-live="polite">
			{#if status === 'submitting' || status === 'processing'}
				<div data-testid={status === 'submitting' ? 'status-submitting' : 'status-processing'}>
					<p class="eyebrow">{status === 'submitting' ? 'Uploading' : 'Processing'}</p>
					<h2>{status === 'submitting' ? 'Sending the photo' : 'Reading attendance'}</h2>
					<ol class="processing-list">
						{#each processingLabels as label, index}
							<li class:active={index === processingStep} class:complete={index < processingStep}>
								<span>{index < processingStep ? '✓' : index + 1}</span>{label}
							</li>
						{/each}
					</ol>
					<p class="muted">Keep this page open while the group is processed.</p>
				</div>
			{:else if status === 'failed'}
				<div class="result-state" data-testid="status-failed">
					<span class="result-icon"><ShieldAlert size={25} /></span>
					<h2>Could not finish</h2>
					<p>{errorMsg}</p>
					<div class="result-actions">
						<button class="button button--primary" type="button" onclick={submitPhoto}>
							<RefreshCw size={17} /> Retry
						</button>
						<button class="button button--secondary" type="button" onclick={resetCapture}
							>Choose another</button
						>
					</div>
				</div>
			{:else if status === 'completed' && result}
				<div class="results" data-testid="result-screen">
					<div class="result-summary">
						<span class="result-icon result-icon--success"><Check size={25} /></span>
						<div>
							<p class="eyebrow">Attendance recorded</p>
							<h2>
								{(result.matched?.length || 0) + (result.new_persons?.length || 0)} people found
							</h2>
						</div>
					</div>

					{#if result.matched?.length}
						<div class="result-group">
							<h3>Matched <span>{result.matched.length}</span></h3>
							<ul class="face-list">
								{#each result.matched as person}
									<li>
										{#if person.source_photo_crop_url}<img
												src={person.source_photo_crop_url}
												alt=""
											/>{/if}
										<span>{personDisplayLabel(person.pump_code, person.display_seq)}</span>
										<Check size={16} aria-hidden="true" />
									</li>
								{/each}
							</ul>
						</div>
					{/if}

					{#if result.new_persons?.length}
						<div class="result-group">
							<h3>New people <span>{result.new_persons.length}</span></h3>
							<ul class="face-list">
								{#each result.new_persons as person}
									<li>
										{#if person.source_photo_crop_url}<img
												src={person.source_photo_crop_url}
												alt=""
											/>{/if}
										<span>{personDisplayLabel(person.pump_code, person.display_seq)}</span>
									</li>
								{/each}
							</ul>
						</div>
					{/if}

					{#if result.fraud_flags?.length}
						<div class="result-group attention-group">
							<h3>Needs review <span>{result.fraud_flags.length}</span></h3>
							{#each result.fraud_flags as flag}
								<p>
									{flag.person_label || 'An attendance overlap'} was also found at {flag.other_pump_code ||
										'another pump'}.
								</p>
							{/each}
						</div>
					{/if}

					{#if result.unknown_faces?.length}
						<div class="result-group attention-group">
							<h3>Awaiting guest review <span>{result.unknown_faces.length}</span></h3>
							<p>These faces were saved for an administrator to review.</p>
						</div>
					{/if}

					<button class="button button--secondary full-button" type="button" onclick={resetCapture}
						>Done</button
					>
				</div>
			{:else}
				<div class="session-details">
					<p class="eyebrow">Session status</p>
					<h2>{sessionTitle()}</h2>
					<dl>
						<div>
							<dt>Date</dt>
							<dd>{today?.today || 'Today'}</dd>
						</div>
						<div>
							<dt>Next step</dt>
							<dd>
								{today?.state === 'locked'
									? 'No more uploads today'
									: today?.can_submit === false
										? `Available ${formatIST(today?.next_allowed_at)}`
										: 'Submit the group photo'}
							</dd>
						</div>
					</dl>
				</div>
			{/if}
		</aside>
	</div>

	{#if selectedFile && status === 'idle'}
		<div class="sticky-submit">
			<button class="button button--primary" type="button" onclick={submitPhoto}>
				<Upload size={18} /> Submit group photo
			</button>
			<button class="button button--ghost" type="button" onclick={resetCapture}>Cancel</button>
		</div>
	{/if}
</div>

<style>
	.capture-page {
		width: min(100%, 72rem);
		margin: 0 auto;
		padding: clamp(1.25rem, 4vw, 2.5rem);
		padding-bottom: 7rem;
	}

	.capture-heading,
	.section-heading,
	.result-summary,
	.photo-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
	}

	.capture-heading {
		margin-bottom: var(--space-6);
	}
	.capture-heading h1 {
		margin: var(--space-1) 0;
		font-size: var(--text-3xl);
	}
	.capture-heading p:last-child,
	.section-heading p {
		margin: 0;
		color: var(--ink-muted);
	}
	.eyebrow {
		margin: 0;
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
	}

	.capture-layout {
		display: grid;
		grid-template-columns: minmax(0, 1.6fr) minmax(18rem, 0.8fr);
		gap: var(--space-5);
		align-items: start;
	}

	.capture-workspace,
	.session-panel {
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-lg);
	}

	.capture-workspace {
		padding: var(--space-5);
	}
	.session-panel {
		min-height: 18rem;
		padding: var(--space-5);
	}
	.section-heading {
		margin-bottom: var(--space-4);
	}
	.section-heading h2,
	.session-panel h2 {
		margin: 0;
		font-size: var(--text-xl);
	}

	.capture-empty {
		display: grid;
		min-height: 25rem;
		place-items: center;
		align-content: center;
		padding: var(--space-7);
		text-align: center;
		background: var(--surface-subtle);
		border: 1px dashed var(--brand-steel);
		border-radius: var(--radius-md);
	}

	.capture-empty strong {
		margin-top: var(--space-3);
		font-size: var(--text-lg);
	}
	.capture-empty p {
		max-width: 27rem;
		margin: var(--space-2) auto var(--space-5);
		color: var(--ink-muted);
	}
	.capture-icon,
	.result-icon {
		display: grid;
		width: 3.25rem;
		height: 3.25rem;
		place-items: center;
		color: var(--brand-teal);
		background: var(--primary-tint);
		border-radius: var(--radius-md);
	}
	.capture-choices,
	.result-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: var(--space-2);
	}

	.photo-preview {
		position: relative;
		overflow: hidden;
		aspect-ratio: 4 / 3;
		background: var(--surface-muted);
		border-radius: var(--radius-md);
	}
	.photo-preview img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
	.processing-overlay {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		color: var(--brand-white);
		background: color-mix(in srgb, var(--ink-strong) 55%, transparent);
	}
	.photo-meta {
		margin-top: var(--space-3);
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.photo-meta span:first-child {
		overflow: hidden;
		color: var(--ink-default);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.processing-list {
		display: grid;
		gap: var(--space-3);
		padding: 0;
		margin: var(--space-6) 0;
		list-style: none;
	}
	.processing-list li {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		color: var(--ink-muted);
	}
	.processing-list li span {
		display: grid;
		width: 1.75rem;
		height: 1.75rem;
		place-items: center;
		border: 1px solid var(--brand-mist);
		border-radius: 50%;
	}
	.processing-list li.active {
		color: var(--ink-strong);
		font-weight: 700;
	}
	.processing-list li.active span,
	.processing-list li.complete span {
		color: var(--primary-on);
		background: var(--brand-teal);
		border-color: var(--brand-teal);
	}
	.muted {
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}

	.result-state {
		display: grid;
		justify-items: start;
	}
	.result-state h2 {
		margin: var(--space-4) 0 var(--space-2);
	}
	.result-state p {
		color: var(--ink-muted);
	}
	.result-icon--success {
		color: var(--primary-on);
		background: var(--brand-teal);
	}
	.result-summary {
		justify-content: flex-start;
		padding-bottom: var(--space-5);
		border-bottom: 1px solid var(--brand-mist);
	}
	.result-summary h2 {
		margin-top: var(--space-1);
	}
	.result-group {
		padding: var(--space-4) 0;
		border-bottom: 1px solid var(--brand-mist);
	}
	.result-group h3 {
		display: flex;
		justify-content: space-between;
		margin: 0 0 var(--space-3);
		font-size: var(--text-sm);
	}
	.result-group h3 span {
		color: var(--ink-muted);
	}
	.face-list {
		display: grid;
		gap: var(--space-2);
		padding: 0;
		margin: 0;
		list-style: none;
	}
	.face-list li {
		display: grid;
		grid-template-columns: 2.25rem 1fr auto;
		align-items: center;
		gap: var(--space-2);
		min-height: 2.25rem;
	}
	.face-list img {
		width: 2.25rem;
		height: 2.25rem;
		object-fit: cover;
		border-radius: var(--radius-sm);
	}
	.face-list :global(svg) {
		color: var(--brand-teal);
	}
	.attention-group p {
		margin: var(--space-2) 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.full-button {
		width: 100%;
		margin-top: var(--space-4);
	}

	.session-details dl {
		display: grid;
		gap: var(--space-3);
		margin: var(--space-6) 0 0;
	}
	.session-details dl div {
		display: grid;
		grid-template-columns: 6rem 1fr;
		gap: var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px solid var(--brand-mist);
	}
	.session-details dt {
		color: var(--ink-muted);
	}
	.session-details dd {
		margin: 0;
		text-align: right;
	}

	.sticky-submit {
		position: fixed;
		z-index: var(--z-sticky);
		right: 0;
		bottom: 0;
		left: 0;
		display: flex;
		justify-content: center;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4) max(var(--space-3), env(safe-area-inset-bottom));
		background: var(--brand-white);
		border-top: 1px solid var(--brand-mist);
		box-shadow: var(--shadow-lg);
	}

	:global(.spin) {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 48rem) {
		.capture-page {
			padding: var(--space-4);
			padding-bottom: 7rem;
		}
		.capture-heading {
			align-items: flex-start;
		}
		.capture-layout {
			grid-template-columns: 1fr;
		}
		.capture-workspace {
			padding: var(--space-4);
		}
		.capture-empty {
			min-height: 21rem;
			padding: var(--space-5);
		}
		.session-panel {
			min-height: auto;
			padding: var(--space-3);
		}
		.session-details dl {
			margin-top: var(--space-4);
		}
	}

	@media (max-width: 30rem) {
		.capture-heading h1 {
			font-size: var(--text-2xl);
		}
		.capture-choices {
			width: 100%;
		}
		.capture-choices .button {
			width: 100%;
		}
		.sticky-submit .button:first-child {
			flex: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.spin) {
			animation: none;
		}
	}
</style>
