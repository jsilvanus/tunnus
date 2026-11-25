/**
 * Service Worker helper for Web Push notifications.
 *
 * Each client application (e.g. Vuorot, Palaute, etc.) can serve this file as
 * its service worker script (e.g. `/sw.js`) or import it via `importScripts()`.
 *
 * It listens for:
 * 1. 'push' events -> displays the notification banner via registration.showNotification
 * 2. 'notificationclick' events -> focuses an open window with the target URL or opens a new one
 */

self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { title: 'Uusi ilmoitus', body: event.data.text() };
    }
  }

  const title = payload.title || 'Uusi ilmoitus';
  /** @type {NotificationOptions} */
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon.png',
    badge: payload.badge || '/badge.png',
    tag: payload.tag || undefined,
    data: payload.data || { url: '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (client.url === targetUrl && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
  );
});
