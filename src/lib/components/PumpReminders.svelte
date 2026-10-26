<script lang="ts">
	// Shift end reminders (Web Push, worker/endReminders.js), in Chrome's recommended flow: a
	// phone that has not answered sees an "Enable notifications" sheet with a short explanation
	// before the guide; only a tap on its button opens Chrome's question, and only once allowed is
	// the phone's subscription saved, with no card after. Not now hides it until the next visit. An allowed phone
	// re-saves its subscription quietly on every visit, no card. Decisions: $lib/pushReminders.
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import BellRing from '@lucide/svelte/icons/bell-ring';
	import X from '@lucide/svelte/icons/x';
	import { t } from '$lib/pumpLang.svelte';
	import {
		enable,
		holdsGuide,
		keyBytes,
		openingState,
		resave,
		type ReminderState
	} from '$lib/pushReminders';

	// The guide waits while the sheet is open (PumpShell).
	let { onhold }: { onhold?: (hold: boolean) => void } = $props();

	const LATER_KEY = 'pump-reminders-later';
	let state = $state<ReminderState>('hidden');
	$effect(() => onhold?.(holdsGuide(state)));

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
				applicationServerKey: keyBytes(publicKey) as BufferSource
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
		// Allowed and saved: nothing more to show.
		const result = await enable(() => Notification.requestPermission(), subscribe);
		state = result === 'on' ? 'hidden' : result;
	}

	onMount(() => {
		const supported =
			'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
		const phone = {
			secure: window.isSecureContext,
			supported,
			iphone: /iPhone|iPad|iPod/.test(navigator.userAgent),
			permission: supported ? Notification.permission : ('default' as NotificationPermission),
			notNow: laterThisVisit()
		};
		state = openingState(phone);
		if (resave(phone)) subscribe().catch(() => {});
	});
</script>

{#if state === 'ask' || state === 'asking'}
	<div class="reminders-sheet" role="dialog" aria-modal="true" aria-labelledby="reminders-title">
		<section class="reminders-sheet__card" data-testid="pump-reminders" data-state={state}>
			<span class="reminders-sheet__icon" aria-hidden="true"><BellRing size={34} /></span>
			<h2 id="reminders-title">{t('Enable notifications')}</h2>
			<p>{t('Get a reminder on this phone when it is time to end the shift.')}</p>
			<p class="reminders-sheet__hint">{t('Tap the button, then tap "Allow".')}</p>
			<button
				class="button button--primary reminders-sheet__enable"
				type="button"
				onclick={allow}
				disabled={state === 'asking'}
				data-testid="reminders-allow"><BellRing size={20} /> {t('Enable notifications')}</button
			>
			<button
				class="button button--ghost"
				type="button"
				onclick={hide}
				data-testid="reminders-later">{t('Not now')}</button
			>
		</section>
	</div>
{:else if state !== 'hidden'}
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
			{#if state === 'blocked'}
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
			{:else}
				<strong>{t('Turn on reminders')}</strong>
				<p>
					{t(
						'On iPhone, tap Share, then "Add to Home Screen", and open the app from the Home Screen.'
					)}
				</p>
			{/if}
		</div>
		<button class="reminders__close" type="button" onclick={hide} aria-label={t('Close')}
			><X size={20} /></button
		>
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

	/* Same place and look as the guide's sheet, which waits behind it. */
	.reminders-sheet {
		position: fixed;
		inset: 0;
		z-index: var(--z-drawer);
		display: grid;
		align-items: end;
		justify-items: center;
		padding: var(--space-3);
		padding-bottom: max(var(--space-3), env(safe-area-inset-bottom));
		background: rgb(16 39 37 / 72%);
	}

	@media (min-width: 40rem) {
		.reminders-sheet {
			align-items: center;
		}
	}

	.reminders-sheet__card {
		display: grid;
		width: min(100%, 30rem);
		gap: var(--space-3);
		padding: var(--space-6) var(--space-4) var(--space-4);
		text-align: center;
		background: var(--surface-raised);
		border-radius: 1.25rem;
		box-shadow: 0 1.25rem 3rem rgb(0 0 0 / 30%);
	}

	.reminders-sheet__icon {
		display: grid;
		width: 4.5rem;
		height: 4.5rem;
		margin: 0 auto;
		place-items: center;
		color: var(--primary-on);
		background: var(--brand-teal);
		border-radius: 999px;
	}

	.reminders-sheet__card h2 {
		margin: 0;
		color: var(--ink-strong);
		font-size: 1.5rem;
	}

	.reminders-sheet__card p {
		margin: 0;
		color: var(--ink-default);
		font-size: 1.125rem;
	}

	.reminders-sheet__card .reminders-sheet__hint {
		color: var(--ink-muted);
		font-size: 1rem;
	}

	.reminders-sheet__card .button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		width: 100%;
	}

	.reminders-sheet__enable {
		min-height: 3.5rem;
		margin-top: var(--space-2);
		font-size: 1.125rem;
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
