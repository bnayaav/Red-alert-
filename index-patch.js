// ════════════════════════════════════════════════
//  PATCH לindex.html — החלף את הפונקציות הבאות
//  (שאר הקוד נשאר זהה)
// ════════════════════════════════════════════════

// ────────────────────────────────────────────────
//  1. החלף את BOOT (DOMContentLoaded) בזה:
// ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  await loadSettlements();   // ← טוען cities.json
  initMap();
  startPolling();
  await initPush();          // ← await כדי שה-SW יהיה מוכן
  loadHistory();
  loadStats();
  // רשום לPeriodicSync אחרי שה-SW רץ
  registerPeriodicSync();
});

// ────────────────────────────────────────────────
//  2. החלף את loadSettlements בזה:
// ────────────────────────────────────────────────
async function loadSettlements() {
  // ── נסה cities.json (קובץ הערים הרשמי) ──
  try {
    const res = await fetch('./cities.json');
    if (res.ok) {
      const data = await res.json();
      const citiesMap = data.cities || {};

      state.settlements = Object.values(citiesMap)
        .filter(c => c.lat && c.lng)
        .map(c => ({
          id:       c.id,
          name:     c.he,
          nameEn:   c.en,
          lat:      c.lat,
          lng:      c.lng,
          time:     c.countdown || 60,
          area:     c.area,
        }));

      console.log(`✅ טעינה: ${state.settlements.length} יישובים מ-cities.json`);

      // שמור ב-SW cache
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'CACHE_CITIES',
          data: data,
        });
      }

      populateCityList();

      // נסה לבחור עיר לפי GPS ברקע
      tryAutoSelectCity();
      return;
    }
  } catch (e) {
    console.warn('cities.json load failed:', e.message);
  }

  // ── Fallback: /settlements מה-Worker ──
  try {
    const res = await fetch(`${WORKER}/settlements`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data.settlements?.length > 100) {
        state.settlements = data.settlements.filter(s => s.lat && s.lng);
        console.log(`✅ טעינה: ${state.settlements.length} יישובים מה-Worker`);
        populateCityList();
        tryAutoSelectCity();
        return;
      }
    }
  } catch (e) {
    console.warn('Worker settlements failed:', e.message);
  }

  // ── Fallback inline ──
  state.settlements = [
    { name:'תל אביב-יפו', lat:32.0853, lng:34.7818, time:90 },
    { name:'ירושלים',     lat:31.7683, lng:35.2137, time:90 },
    { name:'חיפה',        lat:32.7940, lng:34.9896, time:60 },
    { name:'ראשון לציון', lat:31.9730, lng:34.7925, time:90 },
    { name:'אשדוד',       lat:31.8040, lng:34.6550, time:60 },
    { name:'באר שבע',     lat:31.2521, lng:34.7913, time:60 },
    { name:'שדרות',       lat:31.5237, lng:34.5964, time:15 },
    { name:'נתיבות',      lat:31.4202, lng:34.5898, time:15 },
    { name:'קריית שמונה', lat:33.2074, lng:35.5693, time:15 },
    { name:'אשקלון',      lat:31.6688, lng:34.5743, time:45 },
  ];
  populateCityList();
}

// ────────────────────────────────────────────────
//  3. הוסף פונקציה חדשה: tryAutoSelectCity
// ────────────────────────────────────────────────
function tryAutoSelectCity() {
  // נסה לשחזר עיר שנבחרה בעבר
  try {
    const saved = localStorage.getItem('red_selected_city');
    if (saved) {
      const city = JSON.parse(saved);
      // ודא שהעיר עדיין קיימת ברשימה
      const match = state.settlements.find(s => s.name === city.name);
      if (match) {
        selectCity(match);
        return;
      }
    }
  } catch {}

  // אם אין שמור, נסה GPS שקט
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        const nearest = findNearest(pos.coords.latitude, pos.coords.longitude);
        if (nearest) selectCity(nearest);
      },
      () => {}, // שגיאה שקטה
      { timeout: 5000, maximumAge: 300000 } // cache 5 דקות
    );
  }
}

// ────────────────────────────────────────────────
//  4. עדכן selectCity — שמור בlocal storage
// ────────────────────────────────────────────────
function selectCity(city) {
  state.selectedCity = city;
  document.getElementById('city-input').value = city.name;
  updateSelectedBar();
  updateDefenseTime();
  updateRiskLevel();
  if (state.map) {
    state.map.setView([city.lat, city.lng], 13);
    updateMapMarkers();
  }
  renderSafe();
  loadStats();

  // שמור לlocal storage
  try {
    localStorage.setItem('red_selected_city', JSON.stringify({
      name: city.name,
      lat:  city.lat,
      lng:  city.lng,
      time: city.time,
    }));
  } catch {}

  showToast(`📍 ${city.name} נבחרה`);
}

// ────────────────────────────────────────────────
//  5. החלף את initPush בזה:
// ────────────────────────────────────────────────
let swRegistration = null;
let pushSubscribed = false;

async function initPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[Push] Not supported');
    return;
  }

  try {
    // רשום SW
    swRegistration = await navigator.serviceWorker.register('./sw.js', {
      scope:      './',
      updateViaCache: 'none', // תמיד בדוק עדכונים
    });

    console.log('[SW] Registered:', swRegistration.scope);

    // הפעל SW חדש מיד אם יש
    if (swRegistration.waiting) {
      swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }

    swRegistration.addEventListener('updatefound', () => {
      const newSW = swRegistration.installing;
      newSW?.addEventListener('statechange', () => {
        if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
          console.log('[SW] Update available');
          showToast('🔄 עדכון זמין — טען מחדש לעדכון');
        }
      });
    });

    await navigator.serviceWorker.ready;

    // הודעות מה-SW
    navigator.serviceWorker.addEventListener('message', event => {
      const { type, data } = event.data || {};
      if (type === 'ALERT_CLICKED' && data) {
        // הצג התרעה כשהמשתמש לחץ על notification
        showBanner({
          title: 'ירי רקטות ופגזים',
          areas: data.areas || [],
          alert_time: data.time,
        });
      }
    });

    // בדוק האם כבר רשום
    const sub = await swRegistration.pushManager.getSubscription();
    if (sub) {
      pushSubscribed = true;
      updatePushBtn(true);
    }

    if (Notification.permission === 'denied') {
      const btn = document.getElementById('push-btn');
      if (btn) btn.title = 'התרעות חסומות — שנה בהגדרות';
    }

  } catch (e) {
    console.warn('[SW] Registration failed:', e.message);
  }
}

// ────────────────────────────────────────────────
//  6. הוסף פונקציה חדשה: registerPeriodicSync
// ────────────────────────────────────────────────
async function registerPeriodicSync() {
  if (!swRegistration) return;

  // בקש הרשאת periodic-background-sync
  if ('permissions' in navigator) {
    try {
      const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (status.state === 'granted') {
        swRegistration.postMessage({ type: 'REGISTER_PERIODIC_SYNC' });
        console.log('[App] Periodic Sync requested');
      }
    } catch {}
  }

  // Background Sync רגיל (one-shot)
  if ('sync' in swRegistration) {
    try {
      await swRegistration.sync.register('check-alerts');
      console.log('[App] Background Sync registered');
    } catch {}
  }
}
