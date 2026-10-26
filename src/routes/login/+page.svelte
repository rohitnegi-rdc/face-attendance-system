<script lang="ts">
	import { onMount } from 'svelte';
	import { base, resolve } from '$app/paths';
	import { toastConnectionLost, toastIfServerError } from '$lib/toast.svelte';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import AuthPanel from '$lib/components/AuthPanel.svelte';
	let { data } = $props();

	let email = $state('');
	let password = $state('');
	let error = $state('');
	let isSubmitting = $state(false);
	let showPassword = $state(false);
	// Pump logins (made up by the system, @pumps.rdc) have no mailbox: the plant manager resets
	// them, so they get no "Forgot password?" link. Same rule as passwordReset.ts.
	const pumpLogin = $derived(/@pumps\./i.test(email.trim()));
	// Until the page is interactive a click on Sign in is a plain form submit, which silently
	// reloads /login with empty fields (slow phones, and the live E2E run).
	let ready = $state(false);
	onMount(() => (ready = true));

	async function submit(e: Event) {
		e.preventDefault();
		error = '';
		isSubmitting = true;

		try {
			const res = await fetch(resolve('/api/auth/login'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email, password })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				toastIfServerError(res);
				error = data.error || 'We could not sign you in. Check your details and try again.';
				return;
			}
			// Back to the page that sent them here (e.g. an approval email link), when it belongs
			// to this role; anything else (other origins, other roles) goes to the role home.
			const next = new URL(window.location.href).searchParams.get('next') ?? '';
			const safeNext =
				!data.mustChangePassword && next.startsWith(`/${data.role}/`) && !next.startsWith('//')
					? next
					: '';
			window.location.href = safeNext
				? `${base}${safeNext}`
				: resolve(
						data.mustChangePassword
							? '/change-password'
							: `/${data.role as 'admin' | 'vendor' | 'plant-manager' | 'pump'}`
					);
		} catch {
			toastConnectionLost();
			error = 'The service is not reachable right now. Please try again.';
		} finally {
			isSubmitting = false;
		}
	}
</script>

<svelte:head>
	<title>Sign in | Face Attendance</title>
</svelte:head>

<AuthPanel labelledby="login-title">
	<div class="auth-heading">
		<h1 id="login-title">Sign in</h1>
		<p>Use your assigned account to continue.</p>
	</div>

	{#if data.resetDone}
		<p class="alert alert--success" role="status" data-testid="login-reset-done">
			Your password is changed. Sign in with the new one.
		</p>
	{/if}

	<form class="auth-form" onsubmit={submit} data-testid="login-form">
		<label class="field">
			<span>Email address</span>
			<input
				type="email"
				bind:value={email}
				autocomplete="username"
				inputmode="email"
				required
				data-testid="login-email"
			/>
		</label>

		<label class="field">
			<span class="password-label"
				>Password {#if !pumpLogin}<a
						href={resolve('/forgot-password')}
						data-testid="forgot-password-link">Forgot password?</a
					>{/if}</span
			>
			<span class="password-field">
				<input
					type={showPassword ? 'text' : 'password'}
					bind:value={password}
					autocomplete="current-password"
					required
					data-testid="login-password"
				/>
				<button
					class="password-toggle"
					type="button"
					onclick={() => (showPassword = !showPassword)}
					aria-label={showPassword ? 'Hide password' : 'Show password'}
					title={showPassword ? 'Hide password' : 'Show password'}
				>
					{#if showPassword}<EyeOff size={19} />{:else}<Eye size={19} />{/if}
				</button>
			</span>
		</label>

		{#if pumpLogin}
			<p class="pump-reset-note" data-testid="login-pump-reset-note">
				Forgot the pump password? Ask your plant manager for a new one.
			</p>
		{/if}

		{#if error}
			<p class="alert alert--error" role="alert" data-testid="login-error">{error}</p>
		{/if}

		<button
			class="button button--primary auth-submit"
			type="submit"
			disabled={isSubmitting || !ready}
			data-testid="login-submit"
		>
			{#if isSubmitting}<LoaderCircle class="spin" size={18} />{/if}
			{isSubmitting ? 'Signing in...' : 'Sign in'}
		</button>
	</form>

	{#if data.googleOAuthEnabled}
		<div class="login-divider" aria-hidden="true"><span>or</span></div>
		{#if data.oauthError}<p class="alert alert--error" role="alert">{data.oauthError}</p>{/if}
		<a class="button button--secondary google-login" href={resolve('/api/auth/google/start')}>
			Continue with RDC Google account
		</a>
		<p class="oauth-note">Only existing rdc.in accounts can sign in.</p>
	{/if}
</AuthPanel>

<style>
	/* The link sits in the label row so it is found where the password is typed. */
	.password-label {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
	}
	.password-label a {
		color: var(--brand-teal);
		font-weight: 600;
	}

	.pump-reset-note {
		margin: 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}

	.password-field {
		position: relative;
		display: block;
	}

	.password-field input {
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

	.password-toggle:hover {
		color: var(--ink-strong);
		background: var(--surface-muted);
	}

	.login-divider {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin: var(--space-5) 0 var(--space-4);
		color: var(--ink-muted);
	}

	.login-divider::before,
	.login-divider::after {
		content: '';
		flex: 1;
		border-top: 1px solid var(--brand-mist);
	}

	.google-login {
		width: 100%;
		justify-content: center;
		text-decoration: none;
	}

	.oauth-note {
		margin: var(--space-3) 0 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
		text-align: center;
	}

	:global(.spin) {
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.spin) {
			animation: none;
		}
	}
</style>
