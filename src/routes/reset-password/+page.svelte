<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import AuthPanel from '$lib/components/AuthPanel.svelte';
	let { data, form } = $props();
	let saving = $state(false);
	let show = $state(false);
	const expired = $derived(!data.email || (form && 'expired' in form));
</script>

<svelte:head>
	<title>Set a new password | Face Attendance</title>
	<!-- The token is in the address; never send it to another site. -->
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<AuthPanel labelledby="reset-title">
	{#if expired}
		<div class="auth-heading">
			<h1 id="reset-title">This link no longer works</h1>
			<p data-testid="reset-expired">
				A reset link works for 30 minutes and only once. Ask for a new one; the newest email has the
				link that works.
			</p>
		</div>
		<a class="button button--primary auth-submit" href={resolve('/forgot-password')}
			>Get a new link</a
		>
	{:else}
		<div class="auth-heading">
			<h1 id="reset-title">Set a new password</h1>
			<p>
				For <strong data-testid="reset-email">{data.email}</strong>. Use at least 8 characters.
			</p>
		</div>
		<form
			class="auth-form"
			method="POST"
			use:enhance={() => {
				saving = true;
				return async ({ update }) => {
					await update();
					saving = false;
				};
			}}
		>
			<input type="hidden" name="token" value={data.token} />
			<label class="field">
				<span>New password</span>
				<span class="password-field">
					<input
						type={show ? 'text' : 'password'}
						name="password"
						autocomplete="new-password"
						minlength="8"
						maxlength="128"
						required
						data-testid="reset-password"
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
				<span>Type it again</span>
				<input
					type={show ? 'text' : 'password'}
					name="confirmation"
					autocomplete="new-password"
					minlength="8"
					maxlength="128"
					required
					data-testid="reset-confirmation"
				/>
			</label>
			{#if form && 'error' in form}<p class="alert alert--error" role="alert">{form.error}</p>{/if}
			<button
				class="button button--primary auth-submit"
				type="submit"
				disabled={saving}
				data-testid="reset-submit"
			>
				{#if saving}<LoaderCircle class="spin" size={18} />{/if}
				{saving ? 'Saving...' : 'Save new password'}
			</button>
		</form>
	{/if}
	<a class="auth-back" href={resolve('/login')}><ArrowLeft size={17} /> Back to sign in</a>
</AuthPanel>

<style>
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
	.auth-back {
		gap: var(--space-2);
	}
</style>
