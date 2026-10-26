<script lang="ts">
	// Asks the pump to allow shift end reminders (Web Push, worker/endReminders.js). Browsers only
	// show their permission question after a tap, so it opens on the first tap anywhere on the
	// pump screen; the card explains and its button asks again.
	// Once allowed, every visit quietly re-saves this phone's subscription and the card stays
	// away. Not now hides it until the next visit. On an iPhone, push needs the app on the Home
	// Screen first, so the card says how.
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import BellRing from '@lucide/svelte/icons/bell-ring';
	import X from '@lucide/svelte/icons/x';
	import { t } from '$lib/pumpLang.svelte';

	const LATER_KEY = 'pump-reminders-later';
	type State =
		| 'hidden'
		| 'ask'
		| 'asking'
		| 'on'
		| 'blocked'
		| 'iphone'
		| 'failed'
		| 'insecure'
		| 'unsupported';
	let state = $state<State>('hidden');

	function laterThisVisit() {
		try {
			return sessionStorage.getItem(LATER_KEY) === '1';
		} catch {
			return false;
		}
	}

	function hide() {
		state = 'hidden';
		try {
			sessionStorage.setItem(LATER_KEY, '1');
		} catch {
			// Blocked storage: the card comes back on the next page load.
		}
	}

	function keyBytes(base64url: string) {
		const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
			.replace(/-/g, '+')
			.replace(/_/g, '/');
		return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	}

	// SvelteKit registers the service worker; wait for it, but not forever.
	async function serviceWorker() {
		return Promise.race([
			navigator.serviceWorker.ready,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('no service worker')), 10_000)
			)
		]);
	}

	async function subscribe() {
		const registration = await serviceWorker();
		const keyResponse = await fetch(resolve('/api/pump/push'));
		if (!keyResponse.ok) throw new Error('no push key');
		const { publicKey } = await keyResponse.json();
		const subscription =
			(await registration.pushManager.getSubscription()) ??
			(await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: keyBytes(publicKey)
			}));
		const saved = await fetch(resolve('/api/pump/push'), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(subscription.toJSON())
		});
		if (!saved.ok) throw new Error('subscription not saved');
	}

	async function allow() {
		if (state === 'asking') return;
		state = 'asking';
		const permission = await Notification.requestPermission();
		if (permission !== 'granted') {
			state = permission === 'denied' ? 'blocked' : 'ask';
			return;
		}
		try {
			await subscribe();
			state = 'on';
		} catch {
			state = 'failed';
		}
	}

	onMount(() => {
		// Browsers allow notifications only on an https address; on http they are switched off
		// entirely, so say so instead of hiding the card.
		if (!window.isSecureContext) {
			state = 'insecure';
			return;
		}
		const supported =
			'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
		if (!supported) {
			const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent);
			state = iphone ? 'iphone' : 'unsupported';
			return;
		}
		if (Notification.permission === 'granted') {
			subscribe().catch(() => {});
			return;
		}
		if (Notification.permission === 'denied') {
			state = 'blocked';
			return;
		}
		// A phone that has not answered yet: the browser's own question opens on the first tap
		// anywhere on the pump screen (closing the guide counts). Browsers refuse to open it
		// without a tap. The card stays as the fallback.
		if (!laterThisVisit()) state = 'ask';
		const firstTap = (event: MouseEvent) => {
			// The card's own buttons answer for themselves (Not now must not ask).
			if ((event.target as Element | null)?.closest?.('[data-testid="pump-reminders"]')) return;
			if (Notification.permission === 'default') void allow();
		};
		document.addEventListener('click', firstTap, { capture: true, once: true });
		return () => document.removeEventListener('click', firstTap, { capture: true });
	});
</script>

{#if state !== 'hidden'}
	<section
		class="reminders"
		class:reminders--quiet={state === 'blocked' ||
			state === 'failed' ||
			state === 'insecure' ||
			state === 'unsupported'}
		aria-live="polite"
		data-testid="pump-reminders"
		data-state={state}
	>
		<span class="reminders__icon" aria-hidden="true"><BellRing size={22} /></span>
		<div class="reminders__copy">
			{#if state === 'on'}
				<strong>{t('Reminders are on.')}</strong>
				<p>{t('This phone will remind you when it is time to end the shift.')}</p>
			{:else if state === 'blocked'}
				<strong>{t('Reminders are blocked on this phone.')}</strong>
				<p>{t('To turn them on, allow notifications for this site in the browser settings.')}</p>
			{:else if state === 'failed'}
				<strong>{t('Reminders could not be turned on.')}</strong>
				<p>{t('Check the internet and open the app again.')}</p>
			{:else if state === 'insecure'}
				<strong>{t('Reminders need the secure (https) address.')}</strong>
				<p>{t('Open the app with its https:// address to get reminders.')}</p>
			{:else if state === 'unsupported'}
				<strong>{t('This browser cannot show reminders.')}</strong>
				<p>{t('Open the app in Chrome to get reminders.')}</p>
			{:else if state === 'iphone'}
				<strong>{t('Turn on reminders')}</strong>
				<p>
					{t(
						'On iPhone, tap Share, then "Add to Home Screen", and open the app from the Home Screen.'
					)}
				</p>
			{:else}
				<strong>{t('Turn on reminders')}</strong>
				<p>{t('Get a reminder on this phone when it is time to end the shift.')}</p>
				<div class="reminders__actions">
					<button
						class="button button--primary"
						type="button"
						onclick={allow}
						disabled={state === 'asking'}
						data-testid="reminders-allow">{t('Allow reminders')}</button
					>
					<button class="button button--ghost" type="button" onclick={hide}>{t('Not now')}</button>
				</div>
			{/if}
		</div>
		{#if state !== 'ask' && state !== 'asking'}
			<button class="reminders__close" type="button" onclick={hide} aria-label={t('Close')}
				><X size={20} /></button
			>
		{/if}
	</section>
{/if}

<style>
	.reminders {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		margin: var(--space-3) var(--space-4) 0;
		padding: var(--space-3) var(--space-4);
		background: var(--primary-tint);
		border: 1px solid var(--brand-teal);
		border-radius: var(--radius-lg);
	}

	.reminders--quiet {
		background: var(--surface-muted);
		border-color: var(--brand-mist);
	}

	.reminders__icon {
		display: grid;
		flex: none;
		width: 2.5rem;
		height: 2.5rem;
		place-items: center;
		color: var(--primary-on);
		background: var(--brand-teal);
		border-radius: 999px;
	}

	.reminders__copy {
		display: grid;
		flex: 1;
		gap: var(--space-1);
		min-width: 0;
	}

	.reminders__copy strong {
		color: var(--ink-strong);
	}

	.reminders__copy p {
		margin: 0;
		color: var(--ink-default);
		font-size: var(--text-sm);
	}

	.reminders__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}

	.reminders__close {
		display: grid;
		flex: none;
		width: 2.5rem;
		height: 2.5rem;
		place-items: center;
		color: var(--ink-muted);
		background: none;
		border: 0;
		border-radius: 999px;
		cursor: pointer;
	}
</style>
