<script lang="ts">
	import { resolve } from '$app/paths';
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, tick } from 'svelte';
	import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
	import ChartNoAxesCombined from '@lucide/svelte/icons/chart-no-axes-combined';
	import CalendarCheck from '@lucide/svelte/icons/calendar-check';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import ScanFace from '@lucide/svelte/icons/scan-face';
	import UsersRound from '@lucide/svelte/icons/users-round';
	import Building2 from '@lucide/svelte/icons/building-2';
	import FileUp from '@lucide/svelte/icons/file-up';
	import Fuel from '@lucide/svelte/icons/fuel';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import ImageOff from '@lucide/svelte/icons/image-off';
	import Menu from '@lucide/svelte/icons/menu';
	import X from '@lucide/svelte/icons/x';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Settings from '@lucide/svelte/icons/settings';
	import ScrollText from '@lucide/svelte/icons/scroll-text';
	import { toastConnectionLost, toastIfServerError } from '$lib/toast.svelte';

	type NavCounts = { attendance: number; fraud: number; approvals: number };
	type BadgeKey = keyof NavCounts;

	let {
		role,
		userEmail = '',
		navCounts,
		children
	} = $props<{
		role: 'admin' | 'vendor' | 'plant-manager';
		userEmail?: string;
		navCounts?: NavCounts;
		children: import('svelte').Snippet;
	}>();

	// The layout reloads the counts on every navigation; this timer catches new photos and fraud
	// flags while the user stays on one page. Skipped while the tab is hidden.
	const NAV_COUNTS_REFRESH_MS = 60_000;
	onMount(() => {
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') invalidate('app:nav-counts');
		}, NAV_COUNTS_REFRESH_MS);
		return () => clearInterval(timer);
	});

	function badgeCount(key: BadgeKey | undefined) {
		return key && navCounts ? navCounts[key] : 0;
	}

	function badgeTitle(key: BadgeKey) {
		const n = badgeCount(key);
		if (key === 'attendance')
			return `${n} new shift ${n === 1 ? 'photo' : 'photos'} since your last visit`;
		if (key === 'fraud') return `${n} fraud ${n === 1 ? 'case' : 'cases'} waiting for review`;
		return navCounts?.fraud
			? `${n} waiting, ${navCounts.fraud} of them fraud (same person at two pumps)`
			: `${n} waiting for your decision`;
	}

	// Red when fraud is involved; teal for plain news.
	function badgeAlert(key: BadgeKey) {
		return key === 'fraud' || (key === 'approvals' && Boolean(navCounts?.fraud));
	}

	const anyBadge = $derived(
		Boolean(navCounts && (navCounts.attendance || navCounts.fraud || navCounts.approvals))
	);

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

	let drawerOpen = $state(false);
	let menuButton: HTMLButtonElement;
	let drawer: HTMLElement;
	let drawerCloseButton: HTMLButtonElement;

	type NavItem = {
		href: string;
		label: string;
		icon: typeof LayoutDashboard;
		exact?: boolean;
		badge?: BadgeKey;
	};

	const adminItems: NavItem[] = [
		{ href: resolve('/admin'), label: 'Overview', icon: LayoutDashboard, exact: true },
		{ href: resolve('/admin/insights'), label: 'Insights', icon: ChartNoAxesCombined },
		{
			href: resolve('/admin/attendance'),
			label: 'Attendance',
			icon: CalendarCheck,
			badge: 'attendance'
		},
		{
			href: resolve('/admin/fraud-flags'),
			label: 'Fraud flags',
			icon: TriangleAlert,
			badge: 'fraud'
		},
		{ href: resolve('/admin/flagged-guests'), label: 'Guest review', icon: ScanFace },
		{ href: resolve('/admin/merge-candidates'), label: 'Merge review', icon: UsersRound },
		{ href: resolve('/admin/photo-backups'), label: 'Kept photos', icon: ImageOff },
		{ href: resolve('/admin/vendors'), label: 'Vendors', icon: Building2 },
		{ href: resolve('/admin/plant-managers'), label: 'Plant managers', icon: Building2 },
		{ href: resolve('/admin/import'), label: 'Imports', icon: FileUp },
		{ href: resolve('/admin/logs'), label: 'Logs', icon: ScrollText },
		{ href: resolve('/admin/settings'), label: 'Settings', icon: Settings }
	];

	const vendorItems: NavItem[] = [
		{ href: resolve('/vendor'), label: 'Overview', icon: LayoutDashboard, exact: true },
		{
			href: resolve('/vendor/attendance'),
			label: 'Attendance',
			icon: CalendarCheck,
			badge: 'attendance'
		},
		{ href: resolve('/vendor/pumps'), label: 'Pumps', icon: Fuel },
		{ href: resolve('/vendor/people'), label: 'People', icon: UsersRound }
	];
	const plantManagerItems: NavItem[] = [
		{ href: resolve('/plant-manager'), label: 'Overview', icon: LayoutDashboard, exact: true },
		{
			href: resolve('/plant-manager/attendance'),
			label: 'Attendance',
			icon: CalendarCheck,
			badge: 'attendance'
		},
		{
			href: resolve('/plant-manager/approvals'),
			label: 'Approvals',
			icon: MapPin,
			badge: 'approvals'
		},
		{ href: resolve('/plant-manager/photo-backups'), label: 'Kept photos', icon: ImageOff },
		{ href: resolve('/plant-manager/pumps'), label: 'Pumps', icon: Fuel },
		{ href: resolve('/plant-manager/people'), label: 'People', icon: UsersRound }
	];

	let items = $derived(
		role === 'admin' ? adminItems : role === 'vendor' ? vendorItems : plantManagerItems
	);

	function isActive(item: { href: string; exact?: boolean }) {
		return item.exact ? page.url.pathname === item.href : page.url.pathname.startsWith(item.href);
	}

	async function openDrawer() {
		drawerOpen = true;
		await tick();
		drawerCloseButton?.focus();
	}

	function closeDrawer(restoreFocus = true) {
		drawerOpen = false;
		if (restoreFocus) menuButton?.focus();
	}

	function handleDrawerKeydown(event: KeyboardEvent) {
		if (!drawerOpen) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			closeDrawer();
			return;
		}
		if (event.key !== 'Tab') return;
		const focusable = Array.from(
			drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')
		).filter((element) => element.offsetParent !== null);
		if (!focusable.length) return;
		const first = focusable[0];
		const last = focusable.at(-1)!;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}
</script>

<svelte:window onkeydown={handleDrawerKeydown} />

<div class="app-shell">
	<header class="app-topbar">
		<button
			bind:this={menuButton}
			class="icon-button app-topbar__menu"
			type="button"
			aria-label="Open navigation"
			aria-expanded={drawerOpen}
			aria-controls="app-navigation"
			onclick={openDrawer}
		>
			<Menu size={22} />
			{#if anyBadge}<span
					class="menu-dot"
					class:menu-dot--alert={Boolean(navCounts?.fraud)}
					data-testid="nav-menu-dot"
				></span>{/if}
		</button>
		<a
			class="brand"
			href={resolve(role === 'admin' ? '/admin' : role === 'vendor' ? '/vendor' : '/plant-manager')}
			aria-label="Face Attendance home"
		>
			<span class="brand__mark"><ScanFace size={21} /></span>
			<span>Face Attendance</span>
		</a>
		<div class="account">
			<div class="account__copy">
				<strong
					>{role === 'admin'
						? 'Administrator'
						: role === 'vendor'
							? 'Vendor'
							: 'Plant Manager'}</strong
				>
				<span>{userEmail}</span>
			</div>
			<form onsubmit={signOut}>
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
		onclick={() => closeDrawer()}
	></button>

	<aside
		bind:this={drawer}
		id="app-navigation"
		class:open={drawerOpen}
		class="sidebar"
		aria-label="{role} navigation"
	>
		<div class="sidebar__mobile-header">
			<strong>Navigation</strong>
			<button
				bind:this={drawerCloseButton}
				class="icon-button"
				type="button"
				aria-label="Close navigation"
				onclick={() => closeDrawer()}
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
					onclick={() => closeDrawer(false)}
				>
					<Icon size={18} />
					<span>{item.label}</span>
					{#if item.badge && badgeCount(item.badge) > 0}
						<span
							class="nav-badge"
							class:nav-badge--alert={badgeAlert(item.badge)}
							title={badgeTitle(item.badge)}
							aria-label={badgeTitle(item.badge)}
							data-testid="nav-badge-{item.badge}"
							>{badgeCount(item.badge) > 99 ? '99+' : badgeCount(item.badge)}</span
						>
					{/if}
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
		padding: 0 var(--space-5);
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
		padding: var(--space-5) var(--space-3);
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

	.nav-badge {
		min-width: 1.4rem;
		margin-left: auto;
		padding: 0.05rem 0.4rem;
		color: var(--primary-on);
		background: var(--primary-tint);
		border: 1px solid var(--brand-teal);
		border-radius: 999px;
		font-size: var(--text-xs);
		font-weight: 700;
		line-height: 1.3;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	.nav-badge--alert {
		color: var(--brand-white);
		background: var(--alert);
		border-color: var(--alert);
	}

	.app-topbar__menu {
		position: relative;
	}

	.menu-dot {
		position: absolute;
		top: 0.35rem;
		right: 0.35rem;
		width: 0.6rem;
		height: 0.6rem;
		background: var(--brand-teal);
		border: 2px solid var(--brand-white);
		border-radius: 999px;
	}

	.menu-dot--alert {
		background: var(--alert);
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
