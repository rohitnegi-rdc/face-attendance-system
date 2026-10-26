<script lang="ts">
	// Offers to install the pump screen as an app (Android Chrome). An installed app has the RDC
	// icon on the Home screen and Chrome trusts its notifications more, so the shift end
	// reminders are not covered by "this notification might be spam". Shown only while Chrome
	// says the app can be installed; gone once it is. On an iPhone, PumpReminders explains Add to
	// Home Screen instead.
	import { onMount } from 'svelte';
	import { assets } from '$app/paths';
	import Download from '@lucide/svelte/icons/download';
	import { t } from '$lib/pumpLang.svelte';

	type InstallPrompt = Event & {
		prompt: () => Promise<void>;
		userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
	};
	type InstallWindow = Window & { __installPrompt?: InstallPrompt };
	const LATER_KEY = 'pump-install-later';
	let prompt = $state<InstallPrompt | null>(null);
	let installing = $state(false);

	function laterThisVisit() {
		try {
			return sessionStorage.getItem(LATER_KEY) === '1';
		} catch {
			return false;
		}
	}

	function later() {
		prompt = null;
		try {
			sessionStorage.setItem(LATER_KEY, '1');
		} catch {
			// Blocked storage: the card comes back on the next page load.
		}
	}

	async function install() {
		if (!prompt) return;
		installing = true;
		const event = prompt;
		await event.prompt();
		const { outcome } = await event.userChoice;
		installing = false;
		// Chrome lets each announcement be used once.
		prompt = null;
		(window as InstallWindow).__installPrompt = undefined;
		if (outcome !== 'accepted') later();
	}

	onMount(() => {
		const installed =
			matchMedia('(display-mode: standalone)').matches ||
			(navigator as unknown as { standalone?: boolean }).standalone === true;
		if (installed || laterThisVisit()) return;
		const pick = () => {
			const ready = (window as InstallWindow).__installPrompt;
			if (ready) prompt = ready;
		};
		const done = () => (prompt = null);
		pick();
		window.addEventListener('install-ready', pick);
		window.addEventListener('appinstalled', done);
		return () => {
			window.removeEventListener('install-ready', pick);
			window.removeEventListener('appinstalled', done);
		};
	});
</script>

{#if prompt}
	<section class="install" aria-live="polite" data-testid="pump-install">
		<img class="install__icon" src="{assets}/icons/icon-192.png" alt="" width="48" height="48" />
		<div class="install__copy">
			<strong>{t('Install the app')}</strong>
			<p>{t('Open attendance from the Home screen and get reminders without a spam warning.')}</p>
			<div class="install__actions">
				<button
					class="button button--primary"
					type="button"
					onclick={install}
					disabled={installing}
					data-testid="pump-install-button"
					><Download size={18} aria-hidden="true" /> {t('Install app')}</button
				>
				<button class="button button--ghost" type="button" onclick={later}>{t('Not now')}</button>
			</div>
		</div>
	</section>
{/if}

<style>
	.install {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		margin: var(--space-3) var(--space-4) 0;
		padding: var(--space-3) var(--space-4);
		background: var(--primary-tint);
		border: 1px solid var(--brand-teal);
		border-radius: var(--radius-lg);
	}

	.install__icon {
		flex: none;
		width: 3rem;
		height: 3rem;
		background: #fff;
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
		object-fit: cover;
	}

	.install__copy {
		display: grid;
		flex: 1;
		gap: var(--space-1);
		min-width: 0;
	}

	.install__copy strong {
		color: var(--ink-strong);
	}

	.install__copy p {
		margin: 0;
		color: var(--ink-default);
		font-size: var(--text-sm);
	}

	.install__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}

	.install__actions .button {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
	}
</style>
