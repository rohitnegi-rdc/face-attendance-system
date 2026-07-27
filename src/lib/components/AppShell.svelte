<script lang="ts">
	import { page } from '$app/state';
	import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
	import ChartNoAxesCombined from '@lucide/svelte/icons/chart-no-axes-combined';
	import CalendarCheck from '@lucide/svelte/icons/calendar-check';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import ScanFace from '@lucide/svelte/icons/scan-face';
	import UsersRound from '@lucide/svelte/icons/users-round';
	import FileUp from '@lucide/svelte/icons/file-up';
	import Fuel from '@lucide/svelte/icons/fuel';
	import Menu from '@lucide/svelte/icons/menu';
	import X from '@lucide/svelte/icons/x';
	import LogOut from '@lucide/svelte/icons/log-out';

	let {
		role,
		userEmail = '',
		children
	} = $props<{
		role: 'admin' | 'vendor';
		userEmail?: string;
		children: import('svelte').Snippet;
	}>();

	let drawerOpen = $state(false);

	const adminItems = [
		{ href: '/admin', label: 'Overview', icon: LayoutDashboard, exact: true },
		{ href: '/admin/insights', label: 'Insights', icon: ChartNoAxesCombined },
		{ href: '/admin/attendance', label: 'Attendance', icon: CalendarCheck },
		{ href: '/admin/fraud-flags', label: 'Fraud flags', icon: TriangleAlert },
		{ href: '/admin/flagged-guests', label: 'Guest review', icon: ScanFace },
		{ href: '/admin/merge-candidates', label: 'Merge review', icon: UsersRound },
		{ href: '/admin/import', label: 'Imports', icon: FileUp }
	];

	const vendorItems = [
		{ href: '/vendor', label: 'Overview', icon: LayoutDashboard, exact: true },
		{ href: '/vendor/attendance', label: 'Attendance', icon: CalendarCheck },
		{ href: '/vendor/pumps', label: 'Pumps', icon: Fuel },
		{ href: '/vendor/people', label: 'People', icon: UsersRound }
	];

	let items = $derived(role === 'admin' ? adminItems : vendorItems);

	function isActive(item: { href: string; exact?: boolean }) {
		return item.exact ? page.url.pathname === item.href : page.url.pathname.startsWith(item.href);
	}
</script>

<div class="app-shell">
	<header class="app-topbar">
		<button
			class="icon-button app-topbar__menu"
			type="button"
			aria-label="Open navigation"
			onclick={() => (drawerOpen = true)}
		>
			<Menu size={22} />
		</button>
		<a
			class="brand"
			href={role === 'admin' ? '/admin' : '/vendor'}
			aria-label="Face Attendance home"
		>
			<span class="brand__mark"><ScanFace size={21} /></span>
			<span>Face Attendance</span>
		</a>
		<div class="account">
			<div class="account__copy">
				<strong>{role === 'admin' ? 'Administrator' : 'Vendor'}</strong>
				<span>{userEmail}</span>
			</div>
			<form method="POST" action="/api/auth/logout">
				<button class="icon-button" type="submit" aria-label="Sign out" title="Sign out">
					<LogOut size={19} />
				</button>
			</form>
		</div>
	</header>

	<button
		class:visible={drawerOpen}
		class="drawer-backdrop"
		type="button"
		aria-label="Close navigation"
		onclick={() => (drawerOpen = false)}
	></button>

	<aside class:open={drawerOpen} class="sidebar" aria-label="{role} navigation">
		<div class="sidebar__mobile-header">
			<strong>Navigation</strong>
			<button
				class="icon-button"
				type="button"
				aria-label="Close navigation"
				onclick={() => (drawerOpen = false)}
			>
				<X size={21} />
			</button>
		</div>
		<nav>
			{#each items as item}
				{@const Icon = item.icon}
				<a
					class:active={isActive(item)}
					href={item.href}
					aria-current={isActive(item) ? 'page' : undefined}
					onclick={() => (drawerOpen = false)}
				>
					<Icon size={18} />
					<span>{item.label}</span>
				</a>
			{/each}
		</nav>
		<div class="sidebar__footer">
			<span>{role === 'admin' ? 'Platform operations' : 'Assigned operations'}</span>
		</div>
	</aside>

	<main id="main-content" class="app-content">
		{@render children()}
	</main>
</div>

<style>
	.app-shell {
		min-height: 100vh;
		padding-top: 4rem;
		padding-left: var(--sidebar-width);
	}

	.app-topbar {
		position: fixed;
		inset: 0 0 auto 0;
		z-index: var(--z-sticky);
		display: flex;
		height: 4rem;
		align-items: center;
		gap: var(--space-3);
		padding: 0 var(--space-4);
		background: var(--brand-white);
		border-bottom: 1px solid var(--brand-mist);
	}

	.app-topbar__menu {
		display: none;
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--ink-strong);
		font-weight: 700;
		text-decoration: none;
	}

	.brand__mark {
		display: grid;
		width: 2rem;
		height: 2rem;
		place-items: center;
		color: var(--primary-on);
		background: var(--brand-teal);
		border-radius: var(--radius-md);
	}

	.account {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-left: auto;
	}

	.account__copy {
		display: grid;
		text-align: right;
		line-height: 1.25;
	}

	.account__copy strong {
		color: var(--ink-strong);
		font-size: var(--text-sm);
	}

	.account__copy span {
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}

	.sidebar {
		position: fixed;
		inset: 4rem auto 0 0;
		z-index: var(--z-sticky);
		display: flex;
		width: var(--sidebar-width);
		flex-direction: column;
		padding: var(--space-4) var(--space-3);
		background: var(--brand-white);
		border-right: 1px solid var(--brand-mist);
	}

	.sidebar nav {
		display: grid;
		gap: var(--space-1);
	}

	.sidebar nav a {
		display: flex;
		min-height: 2.75rem;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
		color: var(--ink-default);
		border-radius: var(--radius-md);
		font-size: var(--text-sm);
		font-weight: 600;
		text-decoration: none;
	}

	.sidebar nav a:hover {
		background: var(--surface-muted);
	}

	.sidebar nav a.active {
		color: var(--primary-on);
		background: var(--brand-teal);
	}

	.sidebar__mobile-header {
		display: none;
	}

	.sidebar__footer {
		margin-top: auto;
		padding: var(--space-3);
		color: var(--ink-muted);
		font-size: var(--text-xs);
		border-top: 1px solid var(--brand-mist);
	}

	.drawer-backdrop {
		display: none;
	}

	.app-content {
		min-width: 0;
	}

	@media (max-width: 64rem) {
		.app-shell {
			padding-left: 0;
		}

		.app-topbar__menu {
			display: inline-grid;
		}

		.sidebar {
			inset: 0 auto 0 0;
			z-index: var(--z-drawer);
			width: min(20rem, 88vw);
			padding-top: var(--space-3);
			transform: translateX(-105%);
			transition: transform 230ms var(--ease-out);
		}

		.sidebar.open {
			transform: translateX(0);
		}

		.sidebar__mobile-header {
			display: flex;
			min-height: 3rem;
			align-items: center;
			justify-content: space-between;
			margin-bottom: var(--space-4);
		}

		.drawer-backdrop {
			position: fixed;
			inset: 0;
			z-index: var(--z-backdrop);
			display: block;
			padding: 0;
			background: rgb(22 38 37 / 45%);
			border: 0;
			opacity: 0;
			pointer-events: none;
			transition: opacity 180ms var(--ease-out);
		}

		.drawer-backdrop.visible {
			opacity: 1;
			pointer-events: auto;
		}
	}

	@media (max-width: 38rem) {
		.account__copy {
			display: none;
		}

		.brand {
			font-size: var(--text-sm);
		}
	}
</style>
