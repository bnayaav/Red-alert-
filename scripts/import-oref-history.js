const { chromium } = require("playwright");

function normalizeTime(text) {
  const s = String(text || "").trim();
  if (!s) return new Date().toISOString();

  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();

  const m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    let [, day, month, year, hh, mm, ss] = m;
    if (year.length === 2) year = "20" + year;

    const iso =
      year +
      "-" +
      month.padStart(2, "0") +
      "-" +
      day.padStart(2, "0") +
      "T" +
      hh.padStart(2, "0") +
      ":" +
      mm.padStart(2, "0") +
      ":" +
      (ss || "00").padStart(2, "0") +
      "Z";

    return new Date(iso).toISOString();
  }

  return new Date().toISOString();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const captured = [];

  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (!url.includes("oref")) return;

      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("json")) return;

      const text = await response.text();
      if (!text || text.length < 10) return;

      try {
        const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
        captured.push(parsed);
      } catch (_) {}
    } catch (_) {}
  });

  await page.goto("https://www.oref.org.il/heb/alerts-history", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForTimeout(8000);

  let items = [];

  for (const parsed of captured) {
    let rows = [];

    if (Array.isArray(parsed)) rows = parsed;
    else if (Array.isArray(parsed.data)) rows = parsed.data;
    else if (Array.isArray(parsed.items)) rows = parsed.items;
    else if (Array.isArray(parsed.history)) rows = parsed.history;
    else continue;

    for (const row of rows) {
      const areas =
        row.data ||
        row.areas ||
        row.cities ||
        row.areaNames ||
        [];

      if (!Array.isArray(areas) || !areas.length) continue;

      items.push({
        alert_time: normalizeTime(
          row.alertDate ||
          row.alert_time ||
          row.date ||
          row.time
        ),
        title: row.title || row.alertTitle || row.event || "אירוע",
        areas
      });
    }
  }

  const unique = new Map();

  for (const item of items) {
    const key =
      item.alert_time +
      "|" +
      item.title +
      "|" +
      [...item.areas].sort().join(",");
    unique.set(key, item);
  }

  items = [...unique.values()];

  const res = await fetch(
    process.env.IMPORT_URL + "?token=" + process.env.IMPORT_TOKEN,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items })
    }
  );

  const text = await res.text();

  console.log("Imported alerts:", items.length);
  console.log("Server response:", text);

  await browser.close();
})();
