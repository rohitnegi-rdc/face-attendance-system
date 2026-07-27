<script lang="ts">
	import { personDisplayLabel } from '$lib/personLabel';

	let fileInput: HTMLInputElement;
	let status = $state<'idle' | 'submitting' | 'processing' | 'completed' | 'failed'>('idle');
	let errorMsg = $state('');
	let result = $state<any>(null);

	async function onFileChange() {
		const file = fileInput.files?.[0];
		if (!file) return;
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
			// geolocation optional for prototype/testing
		}

		const form = new FormData();
		form.append('photo', file);
		if (lat) form.append('lat', lat);
		if (lng) form.append('lng', lng);

		const res = await fetch('/api/attendance/submit', { method: 'POST', body: form });
		const body = await res.json();
		if (!res.ok) {
			status = 'failed';
			errorMsg = body.error;
			return;
		}

		status = 'processing';
		await poll(body.session_id);
	}

	async function poll(sessionId: string) {
		for (let i = 0; i < 60; i++) {
			await new Promise((r) => setTimeout(r, 2000));
			const res = await fetch(`/api/attendance/status/${sessionId}`);
			const body = await res.json();
			if (body.status === 'completed') {
				status = 'completed';
				result = body;
				return;
			}
			if (body.status === 'failed') {
				status = 'failed';
				errorMsg = body.error_reason || 'Processing failed';
				return;
			}
		}
		status = 'failed';
		errorMsg = 'Timed out waiting for processing';
	}
</script>

<div class="wrap">
	<h1>Pump Attendance Capture</h1>

	<input
		bind:this={fileInput}
		type="file"
		accept="image/*"
		capture="environment"
		onchange={onFileChange}
		data-testid="capture-input"
	/>

	{#if status === 'submitting'}
		<p data-testid="status-submitting">Uploading...</p>
	{:else if status === 'processing'}
		<p data-testid="status-processing">Processing...</p>
	{:else if status === 'failed'}
		<p class="error" data-testid="status-failed">{errorMsg}</p>
		<button onclick={() => (status = 'idle')}>Retry</button>
	{:else if status === 'completed' && result}
		<div data-testid="result-screen">
			<h2>Result</h2>
			{#if result.matched?.length}
				<p class="matched">Matched ({result.matched.length}):</p>
				<ul>
					{#each result.matched as m}
						<li>{personDisplayLabel(m.pump_code, m.display_seq)}</li>
					{/each}
				</ul>
			{/if}
			{#if result.new_persons?.length}
				<p class="new">New persons detected ({result.new_persons.length}):</p>
				<ul>
					{#each result.new_persons as n}
						<li>{personDisplayLabel(n.pump_code, n.display_seq)}</li>
					{/each}
				</ul>
			{/if}
			{#if result.fraud_flags?.length}
				<p class="fraud">Fraud flags ({result.fraud_flags.length}):</p>
				<ul>
					{#each result.fraud_flags as f}
						<li>Person {f.person_id.slice(0, 8)} also seen at pump {f.other_pump_id?.slice(0, 8)}</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

<style>
	.wrap {
		max-width: 480px;
		margin: 2rem auto;
		font-family: sans-serif;
	}
	.error {
		color: #c0392b;
	}
	.matched {
		color: #16a34a;
	}
	.new {
		color: #2563eb;
	}
	.fraud {
		color: #dc2626;
	}
</style>
