// ═══════════════════════════════════════════════
//  צבע אדום — Service Worker v4
//  ✅ Cache ערים מ-cities.json
//  ✅ Background Periodic Sync (Android Chrome PWA)
//  ✅ Push Notifications
//  ✅ Offline support
// ═══════════════════════════════════════════════

const CACHE_NAME  = 'red-alert-v4';
const WORKER_URL  = 'https://red.bnaya-av.workers.dev';

// קבצים לאחסון מקומי
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// cities.json נטען בנפרד כי הוא גדול
const DATA_ASSETS = [
  './cities.json',
];

// ─────────────────────────────────────────────
//  INSTALL — שמור כל הקבצים
// ─────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing v4...');
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // שמור static assets (חובה)
      try {
        await cache.addAll(STATIC_ASSETS);
      } catch (e) {
        console.warn('[SW] Some static assets failed:', e.message);
      }

      // שמור cities.json (ניסיון — לא כשל אם חסר)
      try {
        await cache.addAll(DATA_ASSETS);
        console.log('[SW] cities.json cached');
      } catch (e) {
        console.warn('[SW] cities.json not cached yet:', e.message);
      }

      await self.skipWaiting();
    })()
  );
});

// ─────────────────────────────────────────────
//  ACTIVATE — מחק cache ישן
// ─────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating v4...');
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      );
      // רשום לPeriodicSync אם נתמך
      await tryRegisterPeriodicSync();
      await self.clients.claim();
    })()
  );
});

// ─────────────────────────────────────────────
//  FETCH — אסטרטגיית cache
// ─────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls — תמיד מהרשת, לא מcache
  if (url.hostname.includes('workers.dev') ||
      url.hostname.includes('oref.org.il') ||
      url.hostname.includes('data.gov.il')) {
    return; // browser default
  }

  // cities.json — cache first, עדכון ברקע
  if (url.pathname.endsWith('cities.json')) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // שאר הקבצים — cache first
  if (event.request.method === 'GET') {
    event.respondWith(cacheFirst(event.request));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // עדכן ברקע
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) {
      cache.put(request, response.clone());
      console.log('[SW] cities.json refreshed');
    }
    return response;
  }).catch(() => null);

  return cached || await fetchPromise || new Response('{}', { status: 503 });
}

// ─────────────────────────────────────────────
//  BACKGROUND PERIODIC SYNC
//  עובד על Android Chrome כשהאפליקציה סגורה
//  דורש: PWA מותקנת + הרשאת notifications
// ─────────────────────────────────────────────
async function tryRegisterPeriodicSync() {
  if (!('periodicSync' in self.registration)) {
    console.log('[SW] Periodic Sync not supported');
    return;
  }
  try {
    await self.registration.periodicSync.register('check-alerts', {
      minInterval: 60 * 1000, // בדוק כל דקה (המינימום)
    });
    console.log('[SW] Periodic Sync registered ✅');
  } catch (e) {
    console.warn('[SW] Periodic Sync registration failed:', e.message);
  }
}

self.addEventListener('periodicsync', event => {
  if (event.tag === 'check-alerts') {
    console.log('[SW] Periodic sync fired — checking alerts...');
    event.waitUntil(checkAndNotify());
  }
});

// ─────────────────────────────────────────────
//  BACKGROUND SYNC (one-shot, when online)
// ─────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'check-alerts') {
    event.waitUntil(checkAndNotify());
  }
});

// ─────────────────────────────────────────────
//  CORE: בדוק התרעות ושלח notification
// ─────────────────────────────────────────────
async function checkAndNotify() {
  try {
    const res = await fetch(`${WORKER_URL}/live`, {
      cache: 'no-store',
      headers: { 'X-SW': '1' }
    });
    if (!res.ok) return;
    const data = await res.json();

    if (!data.active || !data.alert) return;

    const alert = data.alert;

    // בדוק אם כבר הצגנו את ההתרעה הזו
    const lastId = await getLastAlertId();
    if (lastId === alert.id) {
      console.log('[SW] Alert already shown:', alert.id);
      return;
    }

    await setLastAlertId(alert.id);
    await showAlertNotification(alert);
    console.log('[SW] New alert shown:', alert.id);
  } catch (e) {
    console.warn('[SW] checkAndNotify error:', e.message);
  }
}

async function showAlertNotification(alert) {
  const areas = alert.areas || [];
  const body = areas.slice(0, 5).join(' · ') + (areas.length > 5 ? ` ועוד ${areas.length - 5}...` : '');

  await self.registration.showNotification('🚨 ' + (alert.title || 'ירי רקטות ופגזים'), {
    body,
    icon:             '/Red-alert-/icon-192.png',
    badge:            '/Red-alert-/icon-192.png',
    tag:              'red-alert-' + alert.id,
    renotify:         true,
    requireInteraction: false,
    silent:           false,
    timestamp:        new Date(alert.alert_time).getTime(),
    data: {
      url:   '/Red-alert-/',
      id:    alert.id,
      areas: areas,
      time:  alert.alert_time,
    },
    actions: [
      { action: 'open',  title: '📱 פתח' },
      { action: 'close', title: '✖ סגור' },
    ],
  });
}

// ─────────────────────────────────────────────
//  PUSH (מהCloudflare Worker)
// ─────────────────────────────────────────────
self.addEventListener('push', event => {
  console.log('[SW] Push received');
  let data = {};
  try { data = event.data?.json() || {}; } catch {}

  const areas = data.areas || [];
  const title = data.title || '🚨 צבע אדום';
  const body  = areas.length
    ? areas.slice(0, 5).join(' · ') + (areas.length > 5 ? ` ועוד ${areas.length - 5}...` : '')
    : data.body || 'התרעה פעילה';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:              '/Red-alert-/icon-192.png',
      badge:             '/Red-alert-/icon-192.png',
      tag:               'red-alert',
      renotify:          true,
      requireInteraction: false,
      silent:            false,
      vibrate:           [200, 100, 200],
      timestamp:         data.time ? new Date(data.time).getTime() : Date.now(),
      data: {
        url:   '/Red-alert-/',
        areas: areas,
        time:  data.time || new Date().toISOString(),
      },
      actions: [
        { action: 'open',  title: '📱 פתח' },
        { action: 'close', title: '✖ סגור' },
      ],
    })
  );
});

// ─────────────────────────────────────────────
//  NOTIFICATION CLICK
// ─────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'close') return;

  const targetUrl = event.notification.data?.url || '/Red-alert-/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // מצא חלון פתוח
      for (const client of list) {
        if (client.url.includes('Red-alert') && 'focus' in client) {
          // שלח מסר לחלון הפתוח עם נתוני ההתרעה
          client.postMessage({
            type: 'ALERT_CLICKED',
            data: event.notification.data,
          });
          return client.focus();
        }
      }
      // פתח חלון חדש
      return clients.openWindow(targetUrl);
    })
  );
});

// ─────────────────────────────────────────────
//  MESSAGES מהאפליקציה
// ─────────────────────────────────────────────
self.addEventListener('message', event => {
  const { type, data } = event.data || {};

  // האפליקציה מבקשת רישום לPeriodicSync
  if (type === 'REGISTER_PERIODIC_SYNC') {
    tryRegisterPeriodicSync();
    return;
  }

  // האפליקציה שולחת trigger לבדיקה מיידית
  if (type === 'CHECK_NOW') {
    checkAndNotify();
    return;
  }

  // האפליקציה מעדכנת cities.json cache
  if (type === 'CACHE_CITIES') {
    cacheCitiesData(data);
    return;
  }
});

async function cacheCitiesData(citiesData) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = new Response(JSON.stringify(citiesData), {
      headers: { 'Content-Type': 'application/json' }
    });
    await cache.put('./cities.json', response);
    console.log('[SW] cities.json cached from app');
  } catch (e) {
    console.warn('[SW] cacheCitiesData error:', e.message);
  }
}

// ─────────────────────────────────────────────
//  INDEXEDDB helpers — שמור ID של התרעה אחרונה
// ─────────────────────────────────────────────
async function getLastAlertId() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('red-alert-sw', 1);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore('meta');
      };
      req.onsuccess = e => {
        const db = e.target.result;
        const tx = db.transaction('meta', 'readonly');
        const get = tx.objectStore('meta').get('lastAlertId');
        get.onsuccess = () => resolve(get.result || null);
        get.onerror   = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function setLastAlertId(id) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('red-alert-sw', 1);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore('meta');
      };
      req.onsuccess = e => {
        const db = e.target.result;
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(id, 'lastAlertId');
        tx.oncomplete = () => resolve();
        tx.onerror    = () => resolve();
      };
      req.onerror = () => resolve();
    } catch { resolve(); }
  });
}
