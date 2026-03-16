/**
 * צבע אדום – Cloudflare Worker
 * Endpoints: /live  /history  /stats
 * Cron:      every minute → fetch + store new alerts
 */

const OREF_URL =
  "https://www.oref.org.il/WarningMessages/alert/alerts.json";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json;charset=UTF-8",
};

/* ──────────────────────────────────────────────
   Helpers
────────────────────────────────────────────── */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

function nowISO() {
  return new Date().toISOString();
}

/**
 * Build a stable deterministic ID for an alert.
 * We hash the alert_time + sorted areas so the same burst
 * always gets the same id even if fetched twice.
 */
async function stableId(alertTime, areas) {
  const raw = alertTime + "|" + [...areas].sort().join(",");
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw)
  );
  return Array.from(new Uint8Array(buf))
    .slice(0, 10)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ──────────────────────────────────────────────
   Fetch + normalise OREF alert
────────────────────────────────────────────── */

async function fetchLiveAlert() {
  const res = await fetch(OREF_URL, {
    headers: {
      Referer: "https://www.oref.org.il/",
      "X-Requested-With": "XMLHttpRequest",
    },
    cf: { cacheTtl: 0 },
  });

  if (res.status === 204 || res.status === 304) return null;

  const text = await res.text();
  if (!text || text.trim() === "") return null;

  let raw;
  try {
    // strip BOM if present
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }

  if (!raw || !raw.data || raw.data.length === 0) return null;

  const areas = Array.isArray(raw.data) ? raw.data : [];
  const alertTime = raw.alertDate || nowISO();
  const id = await stableId(alertTime, areas);

  return {
    id,
    alert_time: alertTime,
    title: raw.title || "ירי רקטות ופגזים",
    category: String(raw.cat || "1"),
    areas,
    raw_json: JSON.stringify(raw),
  };
}

/* ──────────────────────────────────────────────
   DB helpers
────────────────────────────────────────────── */

async function saveAlert(db, alert) {
  // insert alert row (ignore if duplicate)
  await db
    .prepare(
      `INSERT OR IGNORE INTO alerts (id, alert_time, title, category, raw_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      alert.id,
      alert.alert_time,
      alert.title,
      alert.category,
      alert.raw_json
    )
    .run();

  // insert area rows
  for (const area of alert.areas) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO alert_areas (alert_id, area_name) VALUES (?, ?)`
      )
      .bind(alert.id, area)
      .run();
  }
}

async function getHistory(db, area, days) {
  const since = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000
  ).toISOString();

  let rows;
  if (area) {
    rows = await db
      .prepare(
        `SELECT a.id, a.alert_time, a.title, a.category,
                GROUP_CONCAT(aa.area_name) AS areas
         FROM alerts a
         JOIN alert_areas aa ON aa.alert_id = a.id
         WHERE a.alert_time >= ?
           AND a.id IN (
             SELECT alert_id FROM alert_areas WHERE area_name LIKE ?
           )
         GROUP BY a.id
         ORDER BY a.alert_time DESC
         LIMIT 500`
      )
      .bind(since, `%${area}%`)
      .all();
  } else {
    rows = await db
      .prepare(
        `SELECT a.id, a.alert_time, a.title, a.category,
                GROUP_CONCAT(aa.area_name) AS areas
         FROM alerts a
         JOIN alert_areas aa ON aa.alert_id = a.id
         WHERE a.alert_time >= ?
         GROUP BY a.id
         ORDER BY a.alert_time DESC
         LIMIT 500`
      )
      .bind(since)
      .all();
  }

  return (rows.results || []).map((r) => ({
    ...r,
    areas: r.areas ? r.areas.split(",") : [],
  }));
}

async function getStats(db, area, days) {
  const since = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000
  ).toISOString();
  const today = new Date().toISOString().slice(0, 10);

  const baseWhere = area
    ? `a.alert_time >= ? AND a.id IN (SELECT alert_id FROM alert_areas WHERE area_name LIKE ?)`
    : `a.alert_time >= ?`;
  const baseParams = area ? [since, `%${area}%`] : [since];

  const totalRow = await db
    .prepare(
      `SELECT COUNT(DISTINCT a.id) AS total FROM alerts a WHERE ${baseWhere}`
    )
    .bind(...baseParams)
    .first();

  const todayRow = await db
    .prepare(
      `SELECT COUNT(DISTINCT a.id) AS today FROM alerts a
       WHERE a.alert_time >= ? ${area ? `AND a.id IN (SELECT alert_id FROM alert_areas WHERE area_name LIKE ?)` : ""}`
    )
    .bind(...(area ? [today + "T00:00:00.000Z", `%${area}%`] : [today + "T00:00:00.000Z"]))
    .first();

  const lastRow = await db
    .prepare(
      `SELECT MAX(a.alert_time) AS last_time FROM alerts a WHERE ${baseWhere}`
    )
    .bind(...baseParams)
    .first();

  // by hour
  const byHourRows = await db
    .prepare(
      `SELECT CAST(SUBSTR(a.alert_time, 12, 2) AS INTEGER) AS hour,
              COUNT(DISTINCT a.id) AS count
       FROM alerts a WHERE ${baseWhere}
       GROUP BY hour ORDER BY hour`
    )
    .bind(...baseParams)
    .all();

  // by day
  const byDayRows = await db
    .prepare(
      `SELECT SUBSTR(a.alert_time, 1, 10) AS day,
              COUNT(DISTINCT a.id) AS count
       FROM alerts a WHERE ${baseWhere}
       GROUP BY day ORDER BY day`
    )
    .bind(...baseParams)
    .all();

  const byHour = Array(24).fill(0);
  for (const r of byHourRows.results || []) byHour[r.hour] = r.count;

  const byDay = {};
  for (const r of byDayRows.results || []) byDay[r.day] = r.count;

  const lastTime = lastRow?.last_time;
  const minutesSinceLast = lastTime
    ? Math.floor((Date.now() - new Date(lastTime).getTime()) / 60000)
    : null;

  return {
    total: totalRow?.total || 0,
    today: todayRow?.today || 0,
    minutesSinceLast,
    lastAlertTime: lastTime || null,
    byHour,
    byDay,
  };
}

/* ──────────────────────────────────────────────
   Main handler
────────────────────────────────────────────── */

export default {
  /* HTTP fetch handler */
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    /* /live – return current alert (always fresh from OREF) */
    if (path === "/live") {
      try {
        const alert = await fetchLiveAlert();
        if (alert && env.DB) {
          await saveAlert(env.DB, alert);
        }
        return json({ active: !!alert, alert: alert || null, ts: nowISO() });
      } catch (e) {
        return json({ active: false, alert: null, error: e.message, ts: nowISO() });
      }
    }

    /* /history?area=...&days=7 */
    if (path === "/history") {
      if (!env.DB) return json({ error: "DB not configured" }, 503);
      const area = url.searchParams.get("area") || "";
      const days = Math.min(parseInt(url.searchParams.get("days") || "7"), 30);
      try {
        const items = await getHistory(env.DB, area, days);
        return json({ items, area, days });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    /* /stats?area=...&days=7 */
    if (path === "/stats") {
      if (!env.DB) return json({ error: "DB not configured" }, 503);
      const area = url.searchParams.get("area") || "";
      const days = Math.min(parseInt(url.searchParams.get("days") || "7"), 30);
      try {
        const stats = await getStats(env.DB, area, days);
        return json({ stats, area, days });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    /* /schema – one-time DB init (protect in production!) */
    if (path === "/schema" && env.DB) {
      try {
        await env.DB.exec(`
          CREATE TABLE IF NOT EXISTS alerts (
            id TEXT PRIMARY KEY,
            alert_time TEXT,
            title TEXT,
            category TEXT,
            raw_json TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE IF NOT EXISTS alert_areas (
            alert_id TEXT NOT NULL,
            area_name TEXT NOT NULL,
            PRIMARY KEY (alert_id, area_name)
          );
          CREATE INDEX IF NOT EXISTS idx_alert_time ON alerts(alert_time);
          CREATE INDEX IF NOT EXISTS idx_area_name ON alert_areas(area_name);
        `);
        return json({ ok: true, message: "Schema created" });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    return json({ error: "Not found" }, 404);
  },

  /* Cron handler – fires every minute */
  async scheduled(event, env, ctx) {
    try {
      const alert = await fetchLiveAlert();
      if (alert && env.DB) {
        await saveAlert(env.DB, alert);
        console.log(`[cron] saved alert ${alert.id} – areas: ${alert.areas.join(", ")}`);
      } else {
        console.log("[cron] no active alert");
      }
    } catch (e) {
      console.error("[cron] error:", e.message);
    }
  },
};
