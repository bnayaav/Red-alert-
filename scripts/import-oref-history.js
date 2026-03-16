const { chromium } = require("playwright");

function normalizeTime(text) {
  const s = String(text || "").trim();
  if (!s) return new Date().toISOString();

  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();

  const m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    let [, day, month, year, hh, mm, ss] = m;
    if (year.length === 2) year = "20" + year;

    const iso =
      year + "-" +
      month.padStart(2, "0") + "-" +
      day.padStart(2, "0") + "T" +
      (hh || "00").padStart(2, "0") + ":" +
      (mm || "00").padStart(2, "0") + ":" +
      (ss || "00").padStart(2, "0") + "Z";

    const parsed = new Date(iso);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }

  return new Date().toISOString();
}

function uniqueItems(items) {
  const map = new Map();
  for (const item of items) {
    const key =
      item.alert_time + "|" +
      item.title + "|" +
      [...item.areas].sort().join(",");
    map.set(key, item);
  }
  return [...map.values()];
}

function rowsFromParsed(parsed) {
  let rows = [];

  if (Array.isArray(parsed)) rows = parsed;
  else if (Array.isArray(parsed?.data)) rows = parsed.data;
  else if (Array.isArray(parsed?.items)) rows = parsed.items;
  else if (Array.isArray(parsed?.history)) rows = parsed.history;
  else return [];

  const items = [];

  for (const row of rows) {
    const areas =
      row?.data ||
      row?.areas ||
      row?.cities ||
      row?.areaNames ||
      [];

    if (!Array.isArray(areas) || !areas.length) continue;

    items.push({
      alert_time: normalizeTime(
        row?.alertDate ||
        row?.alert_time ||
        row?.date ||
        row?.time ||
        new Date().toISOString()
      ),
      title: row?.title || row?.alertTitle || row?.event || "אירוע",
      areas: areas.map(x => String(x || "").trim()).filter(Boolean)
    });
  }

  return items;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "he-IL",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 2200 }
  });

  const page = await context.newPage();

  const capturedUrls = [];
  let items = [];

  page.on("response", async (response) => {
    try {
      const url = response.url();
      const ct = response.headers()["content-type"] || "";

      if (!url.includes("oref")) return;
      capturedUrls.push(url);

      if (!ct.includes("json") && !url.toLowerCase().includes("history")) return;

      const text = await response.text();
      if (!text || text.length < 5) return;

      try {
        const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
        items.push(...rowsFromParsed(parsed));
      } catch (_) {}
    } catch (_) {}
  });

  await page.goto("https://www.oref.org.il/heb/alerts-history", {
    waitUntil: "domcontentloaded",
    timeout: 90000
  });

  await page.waitForTimeout(12000);

  // נסיון לשלוף טקסט מתוך הדף
  const bodyText = await page.evaluate(() => (document.body?.innerText || "").trim());
  console.log("BODY_TEXT_START");
  console.log(bodyText.slice(0, 4000));
  console.log("BODY_TEXT_END");

  // נסיון לשלוף JSON מתוך תגיות script
  const scriptTexts = await page.evaluate(() =>
    Array.from(document.scripts)
      .map(s => s.textContent || "")
      .filter(Boolean)
      .slice(0, 50)
  );

  for (const txt of scriptTexts) {
    const cleaned = txt.trim();
    if (!cleaned) continue;

    // אם כל הסקריפט עצמו JSON
    if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
      try {
        const parsed = JSON.parse(cleaned);
        items.push(...rowsFromParsed(parsed));
      } catch (_) {}
    }

    // אם יש בו מערך JSON גדול
    const arrMatch = cleaned.match(/\[\s*\{[\s\S]{50,}\}\s*\]/);
    if (arrMatch) {
      try {
        const parsed = JSON.parse(arrMatch[0]);
        items.push(...rowsFromParsed(parsed));
      } catch (_) {}
    }

    // אם יש אובייקט JSON גדול
    const objMatch = cleaned.match(/\{\s*"[A-Za-z0-9_]+":[\s\S]{50,}\}/);
    if (objMatch) {
      try {
        const parsed = JSON.parse(objMatch[0]);
        items.push(...rowsFromParsed(parsed));
      } catch (_) {}
    }
  }

  // fallback: חיפוש טקסטואלי ב-body
  if (items.length === 0 && bodyText) {
    const lines = bodyText
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);

    const results = [];
    const timeRegex = /(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!timeRegex.test(line)) continue;

      const alertTimeMatch = line.match(timeRegex);
      const alert_time = alertTimeMatch ? alertTimeMatch[1] : "";
      const title = lines[i + 1] || "אירוע";

      const areas = [];
      for (let j = i + 2; j < Math.min(i + 12, lines.length); j++) {
        const val = lines[j];
        if (!val) continue;
        if (timeRegex.test(val)) break;
        if (/היסטוריית התרעות|פיקוד העורף|תאריך|שעה|עמוד/.test(val)) continue;
        if (val.length < 2) continue;
        areas.push(val);
      }

      if (areas.length) {
        results.push({
          alert_time: normalizeTime(alert_time),
          title,
          areas
        });
      }
    }

    items.push(...results);
  }

  items = uniqueItems(
    items.filter(item =>
      item &&
      item.alert_time &&
      Array.isArray(item.areas) &&
      item.areas.length
    )
  );

  console.log("CAPTURED_URLS_START");
  console.log(JSON.stringify(capturedUrls.slice(0, 100), null, 2));
  console.log("CAPTURED_URLS_END");

  console.log("IMPORTED_ALERTS_COUNT", items.length);
  console.log("IMPORTED_ALERTS_SAMPLE_START");
  console.log(JSON.stringify(items.slice(0, 10), null, 2));
  console.log("IMPORTED_ALERTS_SAMPLE_END");

  const res = await fetch(
    process.env.IMPORT_URL + "?token=" + process.env.IMPORT_TOKEN,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items })
    }
  );

  const text = await res.text();
  console.log("SERVER_RESPONSE", text);

  await browser.close();
})();
