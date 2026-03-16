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
  const page = await browser.newPage();

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
    waitUntil: "networkidle",
    timeout: 90000
  });

  await page.waitForTimeout(10000);

  // fallback: scrape from DOM if network parsing found nothing
  if (items.length === 0) {
    const domItems = await page.evaluate(() => {
      const text = document.body.innerText || "";
      const lines = text
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
          if (val.length < 2) continue;
          if (/היסטוריית התרעות|פיקוד העורף|תאריך|שעה/.test(val)) continue;

          areas.push(val);
        }

        if (areas.length) {
          results.push({
            alert_time,
            title,
            areas
          });
        }
      }

      return results;
    });

    items.push(...domItems.map(item => ({
      alert_time: normalizeTime(item.alert_time),
      title: item.title || "אירוע",
      areas: Array.isArray(item.areas) ? item.areas : []
    })));
  }

  items = uniqueItems(
    items.filter(item =>
      item &&
      item.alert_time &&
      Array.isArray(item.areas) &&
      item.areas.length
    )
  );

  console.log("Captured URLs:", JSON.stringify(capturedUrls.slice(0, 50), null, 2));
  console.log("Imported alerts:", items.length);

  const res = await fetch(
    process.env.IMPORT_URL + "?token=" + process.env.IMPORT_TOKEN,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items })
    }
  );

  const text = await res.text();
  console.log("Server response:", text);

  await browser.close();
})();
