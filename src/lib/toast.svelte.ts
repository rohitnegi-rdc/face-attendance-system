// App-wide error toasts. A system failure (server error, lost connection, unexpected exception)
// always ends here, so the user is told to contact the admin instead of being left on a stuck
// screen. Expected refusals (wrong password, duplicate photo, 409s) stay as inline messages.
import { CONTACT_ADMIN } from '$lib/errorMessages';

export { CONTACT_ADMIN };

export type Toast = { id: number; message: string; detail?: string };

export const toasts = $state<Toast[]>([]);
let nextId = 1;

export function dismissToast(id: number) {
	const index = toasts.findIndex((toast) => toast.id === id);
	if (index >= 0) toasts.splice(index, 1);
}

export function showErrorToast(detail?: string, message = CONTACT_ADMIN) {
	// A burst of failing requests shows one toast, not a stack of identical ones.
	if (toasts.some((toast) => toast.message === message && toast.detail === detail)) return;
	const id = nextId++;
	toasts.push({ id, message, detail });
	setTimeout(() => dismissToast(id), 10_000);
}

// For a fetch that answered: server-side failures (5xx) are system failures.
export function toastIfServerError(response: Response) {
	if (response.status >= 500) showErrorToast(`The server answered ${response.status}.`);
}

// For a fetch that threw: no answer at all (offline, server down, request cut off).
export function toastConnectionLost() {
	showErrorToast('The server could not be reached.');
}
