// scripts/build.cjs
// Полноценный рендер Chromium + парсинг первых 5 цен "₽"
// Пишем rates.json и кладём debug-артефакты (html/png) для проверки

const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'dist');
const DEBUG_DIR = path.join(ROOT, 'debug');
const MAPPING_PATH = path.join(ROOT, 'mapping.json');

function toNum(s) {
  if (!s) return null;
  return Number(
    s.toString()
      .replace(/\s+/g, '')
      .replace(',', '.')
      .replace(/[^\d.]/g, '')
  );
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function loadMapping() {
  const raw = await fs.readFile(MAPPING_PATH, 'utf-8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error('mapping.json должен быть массивом объектов');
  return data;
}

async function scrapeFunpayPage(browser, key, url) {
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });

  const safeKey = key.replace(/[^a-z0-9_-]+/gi, '_');

  await page.route('**/*', (route) => {
    const req = route.request();
    // режем лишнее (не обязательно, но экономит время)
    if (/\.(png|jpg|jpeg|gif|webp|svg|woff2?|ttf|eot)$/i.test(req.url())) {
      return route.abort();
    }
    route.continue();
  });

  console.log('[NAVIGATE]', key, url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // лёгкое «человеческое» поведение
  await page.waitForTimeout(800);
  await page.mouse.move(200, 200);
  await page.waitForTimeout(400);

  // ждём появления символа ₽ в DOM
  try {
    await page.waitForFunction(
      () => document.body && document.body.innerText && document.body.innerText.includes('₽'),
      { timeout: 20000 }
    );
  } catch (_) {
    // падать не будем — сохраним дебаг и попробуем вытащить, что есть
  }

  // Сохраним дебаг
  await ensureDir(DEBUG_DIR);
  await fs.writeFile(path.join(DEBUG_DIR, `${safeKey}__page.html`), await page.content(), 'utf-8');
  await page.screenshot({ path: path.join(DEBUG_DIR, `${safeKey}__page.png`), fullPage: true });

  // Универсальный извлекатель цен из текста страницы
  const prices = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const matches = Array.from(text.matchAll(/(\d[\d\s]*[.,]\d+)\s*₽/g)).map((m) =>
      m[1].replace(/\s+/g, '').replace(',', '.')
    );
    return matches.slice(0, 10); // возьмем немного с запасом
  });

  const pNums = prices.map(toNum).filter((n) => Number.isFinite(n));
  const top5 = pNums.slice(0, 5);

  await page.close();

  // Сформируем «сырые» трейды (для прозрачности)
  const trades_top5 = top5.map((p) => ({ row_text: `${p} ₽`, price_RUB: p }));

  // усреднение
  const price_RUB =
    top5.length > 0 ? Math.round((top5.reduce((a, b) => a + b, 0) / top5.length) * 100) / 100 : 0;

  return {
    price_RUB,
    change_24h: null,
    change_7d: null,
    updated_at: new Date().toISOString(),
    trades_top5: trades_top5,
  };
}

async function main() {
  await ensureDir(OUT_DIR);
  await ensureDir(DEBUG_DIR);

  const mapping = await loadMapping();

  const browser = await chromium.launch({ headless: true });
  const pairs = {};
  const result = {
    updated_at: new Date().toISOString(),
    source: 'funpay',
    pairs,
  };

  for (const item of mapping) {
    const key = item.key || `${item.game}:${item.currency}`;
    const url = item.funpay_url || item.funpayUri || item.url;
    if (!url) {
      console.warn('[SKIP] Нет funpay_url для', key);
      continue;
    }
    try {
      const parsed = await scrapeFunpayPage(browser, key, url);
      pairs[key] = {
        game: item.game || null,
        currency: item.currency || null,
        ...parsed,
      };
      console.log('[OK]', key, pairs[key].price_RUB, 'руб.');
    } catch (e) {
      console.error('[FAIL]', key, e.message);
      pairs[key] = {
        game: item.game || null,
        currency: item.currency || null,
        price_RUB: 0,
        change_24h: null,
        change_7d: null,
        updated_at: new Date().toISOString(),
        trades_top5: [],
        _error: String(e && e.message ? e.message : e),
      };
    }
  }

  await browser.close();

  const outPath = path.join(OUT_DIR, 'rates.json');
  await fs.writeFile(outPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log('[WRITE]', outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
