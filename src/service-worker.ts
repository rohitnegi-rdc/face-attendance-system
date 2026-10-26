/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
// Shows the shift end reminders (worker/endReminders.js) and opens the pump screen when one is
// tapped. Nothing else: no fetch handler, so pages and photos are never cached or served from here.
const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener('install', () => sw.skipWaiting());
sw.addEventListener('activate', (event) => event.waitUntil(sw.clients.claim()));

sw.addEventListener('push', (event) => {
	const data = event.data?.json() ?? {};
	event.waitUntil(
		sw.registration.showNotification(data.title ?? 'Face Attendance', {
			body: data.body,
			tag: data.tag,
			// A second reminder with the same tag replaces the first and still alerts.
			renotify: Boolean(data.tag),
			requireInteraction: true,
			data: { url: new URL(data.url ?? 'pump', sw.registration.scope).href }
		} as NotificationOptions)
	);
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url: string = event.notification.data?.url ?? sw.registration.scope;
	event.waitUntil(
		(async () => {
			const open = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const pumpTab = open.find((client) => client.url.startsWith(url));
			if (pumpTab) return pumpTab.focus();
			return sw.clients.openWindow(url);
		})()
	);
});
