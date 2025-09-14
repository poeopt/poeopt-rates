/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'dist');
const DEBUG_DIR = path.join(ROOT, 'debug');

/** безопасное имя файла для отладочных скринов/дампов */
function safeFile(name) {
  return String(name).replace(/[^a-z0-9\-_.]+/gi, '-').toLowerCase();
}

/** извлекает число из строки "21,99 ₽" -> 21.99 */
function num(txt) {
  if (!txt) return NaN;
  return parseFloat(String(txt).replace(',', '.').replace(/[^\d.]+/g, ''));
}

/** ждет, пока в таблице появятся видимые строки */
async function waitRows(page, timeoutMs = 20000) {
  const selRow = '.tc-table .tc-item';
  await page.waitForFunction(
    (s) => {
      const rows = Array.from(document.querySelectorAll(s));
      return rows.some((r) => r.offsetParent !== null);
    },
    selRow,
    { timeout: timeoutMs }
  );
}

/** читает top N строк и считает VWAP */
async function readTopVWAP(page, topN = 5) {
  return await page.evaluate((n) => {
    const rowsAll = Array.from(document.querySelectorAll('.tc-table .tc-item'))
      .filter((el) => el.offsetParent !== null);
    const rows = rowsAll.slice(0, n);

    const take = rows.map((row) => {
      const priceTxt =
        row.querySelector('.tc-price')?.textContent ||
        row.querySelector('[class*="price"]')?.textContent || '';
      const amountTxt =
        row.querySelector('.tc-amount, .tc-available, .tc-qty, .tc-quantity')?.textContent ||
        row.querySelector('[class*="amount"], [class*="avail"]')?.textContent ||
        '1';

      const price = parseFloat(String(priceTxt).replace(',', '.').replace(/[^\d.]/g, ''));
      const amt = parseFloat(String(amountTxt).replace(',', '.').replace(/[^\d.]/g, '')) || 1;
      return { price, amt };
    }).filter(x => Number.isFinite(x.price) && Number.isFinite(x.amt) && x.price > 0 && x.amt > 0);

    if (!take.length) return null;

    const totalAmt = take.reduce((a, b) => a + b.amt, 0) || take.length;
    const vwap = take.reduce((s, r) => s + r.price * r.amt, 0) / totalAmt;

    return {
      vwap,
      totalAmt,
      rows: take.length
    };
  }, topN);
}

/** основная функция для одного URL */
async function scrapeOne(browser, item) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  });

  const page = await context.newPage();
  const safe = safeFile(item.key);

  try {
    const res = await page.goto(item.url, { waitUntil: 'networkidle', timeout: 45000 });
    if (!res || !res.ok()) throw new Error(`HTTP ${res ? res.status() : 'no response'}`);

    // ждём появления таблицы
    await waitRows(page);

    // небольшой скролл, чтобы прогрузились ленивые строки/стили
    await page.evaluate(() => window.scrollBy(0, 300));
    await page.waitForTimeout(500);

    const data = await readTopVWAP(page, 5);
    if (!data) throw new Error('Не удалось найти цены в таблице');

    // успех — отладочный скрин (по желанию)
    try {
      await page.screenshot({ path: path.join(DEBUG_DIR, `${safe}.png`), fullPage: false });
    } catch (_) {}

    await context.close();

    return {
      ok: true,
      price_RUB: Math.round((data.vwap + Number.EPSILON) * 100) / 100,
      meta: { rows: data.rows, amount_sum: data.totalAmt }
    };
  } catch (err) {
    console.error(`[${item.key}] error:`, err.message);
    try {
      await fs.promises.mkdir(DEBUG_DIR, { recursive: true });
      await page.screenshot({ path: path.join(DEBUG_DIR, `${safe}_error.png`), fullPage: true });
      await fs.promises.writeFile(
        path.join(DEBUG_DIR, `${safe}_error.txt`),
        `${item.url}\n${err.stack || err.message}`
      );
    } catch (_) {}
    await context.close();
    return { ok: false, error: String(err.message || err) };
  }
}

async function main() {
  await fs.promises.mkdir(OUT_DIR, { recursive: true });
  await fs.promises.mkdir(DEBUG_DIR, { recursive: true });

  const mappingRaw = JSON.parse(await fs.promises.readFile(path.join(ROOT, 'mapping.json'), 'utf8'));
  if (!Array.isArray(mappingRaw)) {
    throw new Error('mapping.json должен быть массивом объектов');
  }

  const browser = await chromium.launch({ headless: true });
  const pairs = {};

  for (const item of mappingRaw) {
    const r = await scrapeOne(browser, item);

    const base = {
      game: item.game,
      currency: item.currency,
      price_RUB: 0,
      change_24h: null,
      change_7d: null,
      updated_at: new Date().toISOString(),
      trades_top5: []
    };

    if (r.ok) {
      base.price_RUB = r.price_RUB;
      base.meta = r.meta;
    } else {
      base.error = r.error;
    }

    pairs[item.key] = base;
  }

  await browser.close();

  const out = {
    updated_at: new Date().toISOString(),
    source: 'funpay',
    pairs
  };

  // write rates.json
  await fs.promises.writeFile(
    path.join(OUT_DIR, 'rates.json'),
    JSON.stringify(out, null, 2),
    'utf8'
  );

  // tiny index.html (чтобы корень gh-pages не был пустым)
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>poeopt-rates</title>
<style>
  body{background:#111;color:#ddd;font:16px/1.4 system-ui,Segoe UI,Roboto,Arial}
  a{color:#8fd}
  .box{max-width:820px;margin:48px auto;padding:16px}
  pre{background:#181818;padding:12px;border-radius:8px;overflow:auto}
</style>
</head>
<body>
  <div class="box">
    <h1>poeopt-rates</h1>
    <p>Данные: <a href="./rates.json">rates.json</a></p>
    <pre id="json">Загрузка...</pre>
  </div>
<script>
fetch('./rates.json').then(r=>r.json()).then(j=>{
  document.getElementById('json').textContent = JSON.stringify(j,null,2);
}).catch(e=>{
  document.getElementById('json').textContent = 'Ошибка: '+e;
});
</script>
</body>
</html>`;
  await fs.promises.writeFile(path.join(OUT_DIR, 'index.html'), html, 'utf8');

  console.log('OK: dist/rates.json + dist/index.html');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
