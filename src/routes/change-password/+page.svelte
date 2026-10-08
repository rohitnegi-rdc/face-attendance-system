<script lang="ts">
	import { resolve } from '$app/paths';
	let { data } = $props();
	let password = $state('');
	let confirmation = $state('');
	let errorMessage = $state('');
	let submitting = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		errorMessage = '';
		submitting = true;
		try {
			const response = await fetch(resolve('/api/auth/password'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ password, confirmation })
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok) {
				errorMessage = result.error ?? 'Could not update your password.';
				return;
			}
			window.location.assign(resolve(`/${result.role as 'admin' | 'vendor' | 'plant-manager' | 'pump'}`));
		} catch {
			errorMessage = 'The service is unavailable. Please try again.';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head><title>Set your password | Face Attendance</title></svelte:head>

<main class="page change-password-page">
	<section class="surface surface--padded" aria-labelledby="password-title">
		<p class="eyebrow">First sign-in</p>
		<h1 id="password-title">Set a new password</h1>
		<p class="supporting">Your account ({data.email}) needs a new password before you continue.</p>
		<form onsubmit={submit}>
			<label class="field">
				<span>New password</span>
				<input bind:value={password} type="password" autocomplete="new-password" minlength="12" maxlength="128" required />
			</label>
			<label class="field">
				<span>Confirm password</span>
				<input bind:value={confirmation} type="password" autocomplete="new-password" minlength="12" maxlength="128" required />
			</label>
			{#if errorMessage}<p class="alert alert--error" role="alert">{errorMessage}</p>{/if}
			<button class="button button--primary" type="submit" disabled={submitting}>
				{submitting ? 'Updating...' : 'Update password'}
			</button>
		</form>
	</section>
</main>

<style>
	.change-password-page { display: grid; place-items: center; min-height: 70vh; }
	.change-password-page > section { width: min(100%, 34rem); }
	.eyebrow, .supporting { color: var(--ink-muted); }
	h1 { margin: 0; font-size: var(--text-2xl); }
	.supporting { margin: var(--space-2) 0 var(--space-5); }
	form { display: grid; gap: var(--space-4); }
	.field { display: grid; gap: var(--space-1); }
	.field > span { font-weight: 600; }
</style>
