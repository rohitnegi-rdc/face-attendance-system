<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import MailCheck from '@lucide/svelte/icons/mail-check';
	import AuthPanel from '$lib/components/AuthPanel.svelte';
	let { form } = $props();
	let sending = $state(false);
	const done = $derived(form && 'result' in form ? form : null);
</script>

<svelte:head><title>Forgot password | Face Attendance</title></svelte:head>

{#snippet askForHelp()}
	<div class="help" data-testid="reset-help">
		<strong>Who can reset it for you</strong>
		<ul>
			<li><span>Pump login</span> your plant manager, or the admin</li>
			<li><span>Vendor or plant manager login</span> the admin</li>
		</ul>
		<p>They give you a temporary password; you choose your own at the next sign-in.</p>
	</div>
{/snippet}

<AuthPanel labelledby="forgot-title">
	{#if done?.result === 'sent'}
		<div class="auth-heading">
			<span class="done-mark" aria-hidden="true"><MailCheck size={24} /></span>
			<h1 id="forgot-title">Check your email</h1>
			<p data-testid="reset-sent">
				If <strong>{done.email}</strong> has an account, a link to set a new password is on its way.
				It works for {done.minutes} minutes and only once.
			</p>
		</div>
		<p class="lead">No email after 5 minutes? Look in the spam folder first.</p>
		{@render askForHelp()}
		<form method="POST" use:enhance class="again">
			<input type="hidden" name="email" value={done.email} />
			<button class="button button--secondary auth-submit" type="submit">Send the link again</button
			>
		</form>
	{:else if done?.result === 'pump'}
		<div class="auth-heading">
			<h1 id="forgot-title">Ask your plant manager</h1>
			<p data-testid="reset-pump">
				<strong>{done.email}</strong> is a pump login. Pump passwords are not reset by email: your plant
				manager sets a temporary password from their Pumps page, and you choose your own at the next sign-in.
			</p>
		</div>
	{:else if done?.result === 'no_mailbox'}
		<div class="auth-heading">
			<h1 id="forgot-title">Ask for a reset</h1>
			<p data-testid="reset-no-mailbox">
				<strong>{done.email}</strong> is a login made by the system. It has no mailbox, so we cannot email
				it a link.
			</p>
		</div>
		{@render askForHelp()}
	{:else}
		<div class="auth-heading">
			<h1 id="forgot-title">Forgot password</h1>
			<p>Enter the email you sign in with. We will email you a link to set a new password.</p>
		</div>
		<p class="pump-note" data-testid="forgot-pump-note">
			<strong>Pump login?</strong> Ask your plant manager to reset it. Pump passwords are not reset by
			email.
		</p>
		<form
			class="auth-form"
			method="POST"
			use:enhance={() => {
				sending = true;
				return async ({ update }) => {
					await update();
					sending = false;
				};
			}}
		>
			<label class="field">
				<span>Email address</span>
				<input
					type="email"
					name="email"
					value={form?.email ?? ''}
					autocomplete="username"
					inputmode="email"
					required
					data-testid="forgot-email"
				/>
			</label>
			{#if form && 'error' in form}<p class="alert alert--error" role="alert">{form.error}</p>{/if}
			<button
				class="button button--primary auth-submit"
				type="submit"
				disabled={sending}
				data-testid="forgot-submit"
			>
				{#if sending}<LoaderCircle class="spin" size={18} />{/if}
				{sending ? 'Sending...' : 'Email me a reset link'}
			</button>
		</form>
	{/if}
	<a class="auth-back" href={resolve('/login')}><ArrowLeft size={17} /> Back to sign in</a>
</AuthPanel>

<style>
	.done-mark {
		display: grid;
		width: 2.75rem;
		height: 2.75rem;
		margin-bottom: var(--space-3);
		place-items: center;
		color: var(--brand-teal);
		background: var(--surface-muted);
		border-radius: 999px;
	}
	.lead {
		margin: 0 0 var(--space-3);
		font-weight: 600;
	}
	.help {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-4);
		background: var(--surface-subtle);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.help ul {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.help li span {
		display: block;
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
	}
	.help p {
		margin: 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.pump-note {
		margin: 0 0 var(--space-4);
		padding: var(--space-3) var(--space-4);
		font-size: var(--text-sm);
		background: var(--surface-subtle);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.again {
		margin-top: var(--space-5);
	}
	.auth-back {
		gap: var(--space-2);
	}
</style>
