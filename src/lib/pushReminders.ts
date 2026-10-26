// Shift end reminders on a pump phone (PumpReminders.svelte), the decisions only, so they can be
// unit tested (tests/unit/pushReminders.test.ts). Chrome's recommended flow: the pump signs in,
// sees an "Enable notifications" button with a short explanation, taps it, Chrome asks, and only
// once allowed is the phone's push subscription saved. Nothing asks the browser on its own.

export type ReminderState =
	'hidden' | 'ask' | 'asking' | 'on' | 'blocked' | 'iphone' | 'failed' | 'insecure' | 'unsupported';

export type Phone = {
	// window.isSecureContext: browsers switch notifications off entirely on http.
	secure: boolean;
	// Service worker, PushManager and Notification all present.
	supported: boolean;
	iphone: boolean;
	permission: NotificationPermission;
	// Not now was tapped earlier in this visit.
	notNow: boolean;
};

// What the pump screen shows when it opens. Granted shows nothing (the subscription is re-saved
// quietly, see resave); a phone that has not answered gets the Enable notifications sheet.
export function openingState(phone: Phone): ReminderState {
	if (!phone.secure) return 'insecure';
	if (!phone.supported) return phone.iphone ? 'iphone' : 'unsupported';
	if (phone.permission === 'granted') return 'hidden';
	if (phone.permission === 'denied') return 'blocked';
	return phone.notNow ? 'hidden' : 'ask';
}

// Every visit of an allowed phone saves its subscription again (a new phone, a renewed key).
export function resave(phone: Phone): boolean {
	return phone.secure && phone.supported && phone.permission === 'granted';
}

// While the sheet waits for an answer, the guide waits behind it.
export function holdsGuide(state: ReminderState): boolean {
	return state === 'ask' || state === 'asking';
}

// The Enable notifications tap: ask the browser, and save the subscription only once allowed.
export async function enable(
	requestPermission: () => Promise<NotificationPermission>,
	subscribe: () => Promise<void>
): Promise<ReminderState> {
	const permission = await requestPermission().catch(() => 'default' as NotificationPermission);
	if (permission === 'denied') return 'blocked';
	// Closed without an answer (or Chrome showed only its quiet bell): the button stays.
	if (permission !== 'granted') return 'ask';
	try {
		await subscribe();
		return 'on';
	} catch {
		return 'failed';
	}
}

// The server's VAPID public key (base64url) as the bytes PushManager.subscribe wants.
export function keyBytes(base64url: string): Uint8Array {
	const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
		.replace(/-/g, '+')
		.replace(/_/g, '/');
	return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
