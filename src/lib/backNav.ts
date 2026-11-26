// Where each page was opened from, so a back link returns to the previous page (like a phone's
// back), not to one fixed page. Recorded by the root layout on every in-app navigation to a new
// path: backFor[to path] = the page it came from, with that page's URL (filters kept) and its tab
// title as the label. Kept per browser tab in sessionStorage, so a reload keeps it.
// Not recorded: query-only changes on one page (filters, day links), going back with the browser,
// returning to the page a back link points at (no Fix attendance -> pump day -> Fix attendance
// loop), and sign-in pages.

export type BackTarget = { href: string; label: string };

const KEY = 'back-nav';
const SKIP_FROM = /^\/(login|link|change-password|reset-password|forgot-password)(\/|$)/;
const TITLE_SUFFIX = /\s*[|·]\s*Face Attendance$/;
let memory: Record<string, BackTarget> | null = null;

function load(): Record<string, BackTarget> {
	if (memory) return memory;
	try {
		memory = JSON.parse(sessionStorage.getItem(KEY) || '{}');
	} catch {
		memory = {};
	}
	return memory!;
}

function save(map: Record<string, BackTarget>) {
	memory = map;
	try {
		sessionStorage.setItem(KEY, JSON.stringify(map));
	} catch {
		// Private window or storage blocked: the in-memory copy still serves this visit.
	}
}

// The page title without " | Face Attendance": "Pump GPS", "PUMPMU6", "Plant attendance".
export function pageLabel(title: string): string {
	return title.replace(TITLE_SUFFIX, '').trim();
}

export function recordNavigation(from: URL, to: URL, title: string, type: string) {
	if (type === 'popstate' || from.origin !== to.origin) return;
	if (from.pathname === to.pathname || SKIP_FROM.test(from.pathname)) return;
	const map = load();
	if (map[from.pathname] && new URL(map[from.pathname].href, from).pathname === to.pathname) return;
	const label = pageLabel(title);
	if (!label || label === 'Face Attendance') return;
	map[to.pathname] = { href: from.pathname + from.search, label };
	save(map);
}

export function backFor(pathname: string): BackTarget | null {
	return load()[pathname] ?? null;
}
