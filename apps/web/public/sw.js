// The service worker, for pop-up notifications only (Web Push,
// docs/notifications.md). It caches nothing and handles no requests: the
// app works as before without it. It's registered only when someone turns
// pop-ups on in Settings or the bell's panel.
//
//   push               show the notification: title, a short body, its link
//   notificationclick  mark it read, then focus an open tab of the app at
//                      the link (or open one)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function safePath(link) {
  return typeof link === 'string' && link.startsWith('/') && !link.startsWith('//') && !/[\s\\]/.test(link) ? link : '/notifications';
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'New notification';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: typeof data.id === 'string' ? data.id : undefined,
      data: { id: typeof data.id === 'string' ? data.id : null, link: safePath(data.link) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { id, link } = event.notification.data || {};
  const url = new URL(safePath(link), self.location.origin).href;
  event.waitUntil(
    (async () => {
      if (id) {
        try {
          await fetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
        } catch {
          // Signed out, or offline: it stays unread.
        }
      }
      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const tab = tabs.find((c) => new URL(c.url).origin === self.location.origin);
      if (tab) {
        // The app moves itself there (live/PushBridge), so nothing reloads.
        tab.postMessage({ type: 'cbld-open', path: safePath(link) });
        await tab.focus();
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
