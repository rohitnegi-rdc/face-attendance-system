<script lang="ts">
	import { resolve } from '$app/paths';
	import ScanFace from '@lucide/svelte/icons/scan-face';
	import LogOut from '@lucide/svelte/icons/log-out';
	import { onMount } from 'svelte';
	import { toastConnectionLost, toastIfServerError } from '$lib/toast.svelte';
	import { loadPumpLang, pumpLang, setPumpHindi, t } from '$lib/pumpLang.svelte';

	let { userEmail = '', children } = $props<{
		userEmail?: string;
		children: import('svelte').Snippet;
	}>();

	onMount(loadPumpLang);

	async function signOut(event: SubmitEvent) {
		event.preventDefault();
		try {
			const response = await fetch(resolve('/api/auth/logout'), { method: 'POST' });
			if (response.ok) window.location.assign(resolve('/login'));
			else toastIfServerError(response);
		} catch {
			toastConnectionLost();
		}
	}
</script>

<div class="pump-shell" lang={pumpLang.hindi ? 'hi' : 'en'}>
	<header class="pump-topbar">
		<a class="pump-brand" href={resolve('/pump')} aria-label="Face Attendance pump home">
			<span class="pump-brand__mark"><ScanFace size={21} /></span>
			<span>
				<strong>{t('Face Attendance')}</strong>
				<small>{userEmail}</small>
			</span>
		</a>
		<div class="pump-actions">
			<button
				class="lang-toggle"
				type="button"
				role="switch"
				aria-checked={pumpLang.hindi}
				aria-label="हिंदी / Hindi"
				data-testid="lang-toggle"
				onclick={() => setPumpHindi(!pumpLang.hindi)}
			>
				<span class:active={!pumpLang.hindi} lang="en">EN</span>
				<span class:active={pumpLang.hindi} lang="hi">हिंदी</span>
			</button>
			<form onsubmit={signOut}>
				<button class="icon-button" type="submit" aria-label={t('Sign out')} title={t('Sign out')}>
					<LogOut size={19} />
				</button>
			</form>
		</div>
	</header>
	<main id="main-content">
		{@render children()}
	</main>
</div>

<style>
	.pump-shell {
		min-height: 100vh;
		padding-top: 4rem;
		background: var(--surface-subtle);
	}

	.pump-topbar {
		position: fixed;
		inset: 0 0 auto 0;
		z-index: var(--z-sticky);
		display: flex;
		height: 4rem;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: 0 max(var(--space-4), env(safe-area-inset-left));
		background: var(--brand-white);
		border-bottom: 1px solid var(--brand-mist);
	}

	.pump-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.lang-toggle {
		display: inline-flex;
		min-height: 2.5rem;
		padding: 0.1875rem;
		gap: 0.125rem;
		background: var(--surface-subtle);
		border: 1px solid var(--brand-mist);
		border-radius: 999px;
		cursor: pointer;
	}

	.lang-toggle span {
		display: grid;
		min-width: 2.75rem;
		place-items: center;
		padding: 0 var(--space-2);
		color: var(--ink-muted);
		font-size: var(--text-sm);
		font-weight: 600;
		border-radius: 999px;
	}

	.lang-toggle span.active {
		color: var(--primary-on);
		background: var(--brand-teal);
	}

	.pump-brand {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--ink-strong);
		text-decoration: none;
	}

	.pump-brand > span:last-child {
		display: grid;
		line-height: 1.2;
	}

	.pump-brand small {
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}

	.pump-brand__mark {
		display: grid;
		width: 2rem;
		height: 2rem;
		place-items: center;
		color: var(--primary-on);
		background: var(--brand-teal);
		border-radius: var(--radius-md);
	}
</style>
