import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const DEBUG_DIR = path.join(ROOT, "debug");

// утилиты
async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function parseRub(text) {
  // Берём первое число (допускаем запятую как разделитель)
  const m = (text || "").replace(/\u00A0/g, " ").match(/(\d+[,\.\d]*)/);
  if (!m) return null;
  const num = parseFloat(m[1].replace(",", "."));
  return isFinite(num) ? num : null;
}

async function scrapeOne(ctx, entry) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(65000);
  let price = null;
  let error = null;

  try {
    await page.goto(entry.url, { waitUntil: "domcontentloaded", timeout: 65000 });

    // ждём появления ячейки цены
    await page.waitForSelector(entry.selector, { timeout: 65000 });

    // берём первую видимую цену
    const priceText = await page.$$eval(entry.selector, nodes => {
      const visible = nodes.find(n => n && n.offsetParent !== null) || nodes[0];
      return visible ? visible.textContent.trim() : "";
    });

    price = parseRub(priceText);

    // отладочный скрин
    await page.screenshot({ path: path.join(DEBUG_DIR, `${entry.key}.png`), fullPage: true });
  } catch (e) {
    error = `${e.name}: ${e.message}`;
    // скрин при ошибке
    try {
      await page.screenshot({ path: path.join(DEBUG_DIR, `${entry.key}-error.png`), fullPage: true });
    } catch (_) {}
  } finally {
    await page.close();
  }

  return { price, error };
}

async function main() {
  await ensureDir(DIST);
  await ensureDir(DEBUG_DIR);

  const mappingPath = path.join(ROOT, "mapping.json");
  const mappingRaw = await fs.readFile(mappingPath, "utf8");
  const mapping = JSON.parse(mappingRaw);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "ru-RU",
    timezoneId: "Europe/Moscow", // можно заменить на твою
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
  });

  const pairs = {};
  const now = new Date().toISOString();

  for (const entry of mapping) {
    const { price, error } = await scrapeOne(context, entry);

    pairs[entry.key] = {
      game: entry.game,
      currency: entry.currency,
      price_RUB: price ?? 0,
      change_24h: null,
      change_7d: null,
      updated_at: new Date().toISOString(),
      trades_top5: [],
      ...(error ? { error } : {})
    };
  }

  await browser.close();

  const rates = {
    updated_at: now,
    source: "funpay",
    pairs
  };

  const outPath = path.join(DIST, "rates.json");
  await fs.writeFile(outPath, JSON.stringify(rates, null, 2), "utf8");

  // минимальный индекс для просмотра
  const indexHtml = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<title>poeopt-rates</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  body{background:#0e0e0e;color:#eaeaea;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial}
  .wrap{max-width:980px;margin:32px auto;padding:0 16px}
  a{color:#7fd1ff}
  pre{background:#111;padding:16px;border-radius:8px;overflow:auto}
</style>
</head>
<body>
  <div class="wrap">
    <h1>poeopt-rates</h1>
    <p>Данные: <a href="rates.json">rates.json</a></p>
    <p>Ниже — последнее содержимое файла:</p>
    <pre id="out">Загрузка...</pre>
  </div>
<script>
fetch('rates.json',{cache:'no-store'})
 .then(r=>r.json())
 .then(j=>{ document.getElementById('out').textContent = JSON.stringify(j,null,2); })
 .catch(e=>{ document.getElementById('out').textContent='Ошибка загрузки: '+e; });
</script>
</body>
</html>`;
  await fs.writeFile(path.join(DIST, "index.html"), indexHtml, "utf8");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
