<script lang="ts">
	import { resolve } from '$app/paths';
	import LogOut from '@lucide/svelte/icons/log-out';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import PumpGuide from '$lib/components/PumpGuide.svelte';
	import RdcLogo from '$lib/components/RdcLogo.svelte';
	import PumpReminders from '$lib/components/PumpReminders.svelte';
	import { onMount, tick, untrack } from 'svelte';
	import { toastConnectionLost, toastIfServerError } from '$lib/toast.svelte';
	import { loadPumpLang, pumpLang, setPumpHindi, t } from '$lib/pumpLang.svelte';

	let {
		userEmail = '',
		guideDone = true,
		children
	} = $props<{
		userEmail?: string;
		guideDone?: boolean;
		children: import('svelte').Snippet;
	}>();

	// The guide opens on every visit. Until the pump finishes it once it cannot be closed; after
	// that it has a close (X) button, and the Help button opens it again. The page load decides;
	// later changes are local.
	const startedDone = untrack(() => guideDone);
	let guideFinished = $state(startedDone);
	let guideOpen = $state(true);
	let guideForced = $state(!startedDone);
	// A phone that has not answered about reminders sees the Enable notifications sheet first
	// (PumpReminders); the guide waits behind it. Neither is known before the page runs in the
	// browser, so the guide appears once the sheet has decided, never flashing in and out.
	let remindersHold = $state(false);
	let decided = $state(false);
	const guideShown = $derived(decided && guideOpen && !remindersHold);

	onMount(async () => {
		loadPumpLang();
		await tick();
		decided = true;
	});

	async function closeGuide() {
		guideOpen = false;
		if (guideFinished) return;
		guideFinished = true;
		guideForced = false;
		try {
			const response = await fetch(resolve('/api/pump/guide'), { method: 'POST' });
			if (!response.ok) toastIfServerError(response);
		} catch {
			toastConnectionLost();
		}
	}

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
	<header class="pump-topbar" inert={guideShown}>
		<a class="pump-brand" href={resolve('/pump')} aria-label="Face Attendance pump home">
			<span class="pump-brand__mark"><RdcLogo height={2.25} /></span>
			<span>
				<strong>{t('Face Attendance')}</strong>
				<small>{userEmail}</small>
			</span>
		</a>
		<div class="pump-actions">
			<button
				class="help-button"
				type="button"
				onclick={() => (guideOpen = true)}
				aria-label={t('How to use the app')}
				data-testid="guide-help"
			>
				<CircleHelp size={19} />
				<span>{t('Help')}</span>
			</button>
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
	<main id="main-content" inert={guideShown}>
		<PumpReminders onhold={(hold) => (remindersHold = hold)} />
		{@render children()}
	</main>
	{#if guideShown}
		<PumpGuide forced={guideForced} onclose={closeGuide} />
	{/if}
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

	.help-button {
		display: inline-flex;
		min-height: 2.5rem;
		align-items: center;
		gap: 0.25rem;
		padding: 0 var(--space-2);
		color: var(--ink-strong);
		font-size: var(--text-sm);
		font-weight: 700;
		background: var(--primary-tint);
		border: 1px solid var(--brand-teal);
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

	/* On a phone the Help, language and sign-out buttons need the width; the page itself shows
	   the pump code. */
	@media (max-width: 30rem) {
		.pump-brand > span:last-child {
			display: none;
		}
	}

	.pump-brand small {
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}

	.pump-brand__mark {
		display: flex;
		align-items: center;
	}
</style>
