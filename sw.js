// ═══════════════════════════════════════════════
//  צבע אדום — Service Worker
//  מטפל ב: Push Notifications + Cache
// ═══════════════════════════════════════════════

const CACHE = 'red-alert-v1';
const ASSETS = ['/', '/index.html', '/settlements.json', '/manifest.json'];

// ── Install ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

// ── Activate ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch (cache first for assets) ──
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('workers.dev')) return; // never cache API
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Push ──
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data?.json() || {}; } catch {}

  const title = data.title || '🚨 צבע אדום';
  const body  = data.areas
    ? data.areas.slice(0, 5).join(' · ')
    : data.body || 'התרעה פעילה';

  const options = {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'red-alert',           // replace existing notification
    renotify: true,
    requireInteraction: false,
    silent: false,
    vibrate: [],                // no vibration per requirements
    data: { url: '/', areas: data.areas || [], time: data.time || new Date().toISOString() },
    actions: [
      { action: 'open', title: 'פתח אפליקציה' },
      { action: 'close', title: 'סגור' }
    ]
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'close') return;

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus existing window if open
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      return clients.openWindow('/');
    })
  );
});
