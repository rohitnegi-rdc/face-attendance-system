<script lang="ts">
	import { resolve } from '$app/paths';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ScanFace from '@lucide/svelte/icons/scan-face';
	let { data } = $props();

	let email = $state('');
	let password = $state('');
	let error = $state('');
	let isSubmitting = $state(false);
	let showPassword = $state(false);

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
				error = data.error || 'We could not sign you in. Check your details and try again.';
				return;
			}
			window.location.href = resolve(data.mustChangePassword ? '/change-password' : `/${data.role as 'admin' | 'vendor' | 'plant-manager' | 'pump'}`);
		} catch {
			error = 'The service is not reachable right now. Please try again.';
		} finally {
			isSubmitting = false;
		}
	}
</script>

<svelte:head>
	<title>Sign in | Face Attendance</title>
</svelte:head>

<main id="main-content" class="login-page">
	<section class="login-panel" aria-labelledby="login-title">
		<div class="product-lockup">
			<span class="product-mark" aria-hidden="true"><ScanFace size={28} strokeWidth={1.8} /></span>
			<div>
				<strong>Face Attendance</strong>
				<span>Workforce operations</span>
			</div>
		</div>

		<div class="login-heading">
			<h1 id="login-title">Sign in</h1>
			<p>Use your assigned account to continue.</p>
		</div>

		<form onsubmit={submit} data-testid="login-form">
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
				<span>Password</span>
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

			{#if error}
				<p class="alert alert--error" role="alert" data-testid="login-error">{error}</p>
			{/if}

			<button
				class="button button--primary submit-button"
				type="submit"
				disabled={isSubmitting}
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
	</section>
</main>

<style>
	.login-page {
		display: grid;
		min-height: 100vh;
		place-items: center;
		padding: var(--space-6) var(--space-4);
		background:
			linear-gradient(90deg, transparent 49.8%, var(--brand-mist) 50%, transparent 50.2%),
			var(--surface-subtle);
	}

	.login-panel {
		width: min(100%, 27rem);
		padding: clamp(1.5rem, 5vw, 2.5rem);
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
	}

	.product-lockup {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	.product-lockup > div {
		display: grid;
		line-height: 1.25;
	}

	.product-lockup strong {
		color: var(--ink-strong);
		font-size: var(--text-lg);
	}

	.product-lockup span:last-child {
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}

	.product-mark {
		display: grid;
		width: 2.75rem;
		height: 2.75rem;
		place-items: center;
		color: var(--primary-on);
		background: var(--brand-teal);
		border-radius: var(--radius-md);
	}

	.login-heading {
		margin: var(--space-8) 0 var(--space-6);
	}

	h1 {
		margin: 0;
		font-size: var(--text-3xl);
	}

	.login-heading p {
		margin: var(--space-2) 0 0;
		color: var(--ink-muted);
	}

	form {
		display: grid;
		gap: var(--space-5);
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

	.submit-button {
		width: 100%;
		min-height: 2.75rem;
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

	@media (max-width: 34rem) {
		.login-page {
			align-items: start;
			padding-top: max(4rem, 14vh);
			background: var(--brand-white);
		}

		.login-panel {
			padding: 0;
			border: 0;
			box-shadow: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.spin) {
			animation: none;
		}
	}
</style>
