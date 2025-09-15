import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const DIST_DIR = path.join(root, "dist");
const DEBUG_DIR = path.join(root, "debug");

// аккуратные имена файлов (без двоеточий и прочего)
const slug = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "x";

async function ensureDirs() {
  await fs.mkdir(DIST_DIR, { recursive: true });
  await fs.mkdir(DEBUG_DIR, { recursive: true });
}

function parsePriceRUB(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/\s+/g, " ")
    .replace(",", ".")
    .replace(/[^\d.]/g, "");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

async function readMapping() {
  const raw = await fs.readFile(path.join(root, "mapping.json"), "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error("mapping.json должен быть массивом объектов");
  }
  return data;
}

async function scrapeFunpay(page, url, debugName) {
  // более «толстые» тайминги, чтобы пережить лейзи-загрузку
  const TIMEOUT = 45000;

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT });

  // Ждём, когда появится таблица с офферами
  await page.waitForSelector("div.tc-item .tc-price", { timeout: TIMEOUT });

  // Берём цену первого реального оффера
  const prices = await page.$$eval("div.tc-item .tc-price", (nodes) =>
    nodes
      .map((n) => (n.textContent || "").trim())
      .filter(Boolean)
  );

  let price = null;
  for (const p of prices) {
    const num = (p && p.length) ? parseFloat(p.replace(",", ".").replace(/[^\d.]/g, "")) : null;
    if (Number.isFinite(num)) {
      price = num;
      break;
    }
  }

  if (!Number.isFinite(price)) {
    // снимаем скрин, чтобы понимать, что увидел раннер
    await page.screenshot({ path: path.join(DEBUG_DIR, `${slug(debugName)}.png`) });
    throw new Error("Не удалось распарсить цену: селекторы не нашли валидного значения");
  }

  return price;
}

async function build() {
  await ensureDirs();
  const mapping = await readMapping();

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
  });

  const page = await context.newPage();

  const pairsOut = {};
  const nowISO = new Date().toISOString();

  for (const m of mapping) {
    const key = m.key;
    const safeKey = slug(key);

    const base = {
      game: m.game,
      currency: m.currency,
      price_RUB: 0,
      change_24h: null,
      change_7d: null,
      updated_at: nowISO,
      trades_top5: []
    };

    try {
      const price = await scrapeFunpay(page, m.funpay_url, safeKey);
      pairsOut[key] = { ...base, price_RUB: price };
    } catch (err) {
      pairsOut[key] = { ...base };
      // Вкладываем текст ошибки (но JSON останется валидным)
      pairsOut[key].error = String(err && err.message ? err.message : err);
    }
  }

  await browser.close();

  const out = {
    updated_at: nowISO,
    source: "funpay",
    pairs: pairsOut
  };

  // пишем JSON
  await fs.writeFile(
    path.join(DIST_DIR, "rates.json"),
    JSON.stringify(out, null, 2),
    "utf8"
  );

  // простой viewer (корень страницы)
  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>poeopt-rates</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{background:#0f0f0f;color:#eee;font-family:ui-monospace,Menlo,Consolas,monospace;margin:40px}
    a{color:#8bd5ff}
    pre{white-space:pre-wrap;word-break:break-word;background:#151515;border-radius:10px;padding:20px;line-height:1.35}
  </style>
</head>
<body>
  <h1>poeopt-rates</h1>
  <p>Данные: <a href="rates.json">rates.json</a></p>
  <pre id="out">Загрузка…</pre>
  <script>
    fetch('rates.json').then(r=>r.json()).then(j=>{
      document.getElementById('out').textContent = JSON.stringify(j, null, 2);
    }).catch(e=>{
      document.getElementById('out').textContent = 'Ошибка загрузки: ' + e;
    });
  </script>
</body>
</html>`;
  await fs.writeFile(path.join(DIST_DIR, "index.html"), html, "utf8");
}

build().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
});
