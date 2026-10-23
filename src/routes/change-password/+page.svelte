<script lang="ts">
	import { resolve } from '$app/paths';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import { toastConnectionLost, toastIfServerError } from '$lib/toast.svelte';
	let { data } = $props();
	// One eye shows both boxes, the same as Set a new password (reset-password).
	let show = $state(false);
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
				toastIfServerError(response);
				errorMessage = result.error ?? 'Could not update your password.';
				return;
			}
			window.location.assign(
				resolve(`/${result.role as 'admin' | 'vendor' | 'plant-manager' | 'pump'}`)
			);
		} catch {
			toastConnectionLost();
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
				<span class="password-field">
					<input
						bind:value={password}
						type={show ? 'text' : 'password'}
						autocomplete="new-password"
						minlength="12"
						maxlength="128"
						required
						data-testid="new-password"
					/>
					<button
						class="password-toggle"
						type="button"
						onclick={() => (show = !show)}
						aria-label={show ? 'Hide password' : 'Show password'}
						title={show ? 'Hide password' : 'Show password'}
					>
						{#if show}<EyeOff size={19} />{:else}<Eye size={19} />{/if}
					</button>
				</span>
			</label>
			<label class="field">
				<span>Confirm password</span>
				<input
					bind:value={confirmation}
					type={show ? 'text' : 'password'}
					autocomplete="new-password"
					minlength="12"
					maxlength="128"
					required
					data-testid="confirm-password"
				/>
			</label>
			{#if errorMessage}<p class="alert alert--error" role="alert">{errorMessage}</p>{/if}
			<button class="button button--primary" type="submit" disabled={submitting}>
				{submitting ? 'Updating...' : 'Update password'}
			</button>
		</form>
	</section>
</main>

<style>
	.change-password-page {
		display: grid;
		place-items: center;
		min-height: 70vh;
	}
	.change-password-page > section {
		width: min(100%, 34rem);
	}
	.eyebrow,
	.supporting {
		color: var(--ink-muted);
	}
	h1 {
		margin: 0;
		font-size: var(--text-2xl);
	}
	.supporting {
		margin: var(--space-2) 0 var(--space-5);
	}
	form {
		display: grid;
		gap: var(--space-4);
	}
	.field {
		display: grid;
		gap: var(--space-1);
	}
	.field > span {
		font-weight: 600;
	}
	.password-field {
		position: relative;
		display: block;
	}
	.password-field input {
		width: 100%;
		padding-right: 3rem;
	}
	.password-toggle {
		position: absolute;
		top: 50%;
		right: var(--space-2);
		display: grid;
		width: 2.25rem;
		height: 2.25rem;
		place-items: center;
		color: var(--ink-muted);
		background: transparent;
		border: 0;
		border-radius: var(--radius-sm);
		transform: translateY(-50%);
		cursor: pointer;
	}
</style>
