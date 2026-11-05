// Filters that apply as you type or choose, with no Search button (SearchField.svelte). The page's
// server load does the filtering, so the URL stays shareable and paging restarts at page 1.
import { goto } from '$app/navigation';

export function applyFilters(form: HTMLFormElement) {
	const params = new URLSearchParams();
	for (const [name, value] of new FormData(form)) {
		const text = String(value).trim();
		if (text) params.append(name, text);
	}
	const query = params.toString();
	// The page's own path, which already includes the base path.
	// eslint-disable-next-line svelte/no-navigation-without-resolve
	return goto(`${location.pathname}${query ? `?${query}` : ''}`, {
		keepFocus: true,
		noScroll: true,
		replaceState: true
	});
}

// On the filter form: <form onchange={applyOnSelect}>. A dropdown applies at once.
export function applyOnSelect(event: Event) {
	const target = event.target;
	if (target instanceof HTMLSelectElement && target.form) void applyFilters(target.form);
}
