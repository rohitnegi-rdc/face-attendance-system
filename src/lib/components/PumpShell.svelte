<script lang="ts">
	import { resolve } from '$app/paths';
	import ScanFace from '@lucide/svelte/icons/scan-face';
	import LogOut from '@lucide/svelte/icons/log-out';

	let { userEmail = '', children } = $props<{
		userEmail?: string;
		children: import('svelte').Snippet;
	}>();

	async function signOut(event: SubmitEvent) {
		event.preventDefault();
		const response = await fetch(resolve('/api/auth/logout'), { method: 'POST' });
		if (response.ok) window.location.assign(resolve('/login'));
	}
</script>

<div class="pump-shell">
	<header class="pump-topbar">
		<a class="pump-brand" href={resolve('/pump')} aria-label="Face Attendance pump home">
			<span class="pump-brand__mark"><ScanFace size={21} /></span>
			<span>
				<strong>Face Attendance</strong>
				<small>{userEmail}</small>
			</span>
		</a>
		<form onsubmit={signOut}>
			<button class="icon-button" type="submit" aria-label="Sign out" title="Sign out">
				<LogOut size={19} />
			</button>
		</form>
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
