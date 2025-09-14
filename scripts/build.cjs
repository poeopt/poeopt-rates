// scripts/build.cjs (CommonJS)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = process.cwd();
const MAP_PATH = path.join(ROOT, 'mapping.json');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_PATH = path.join(OUT_DIR, 'rates.json');
const DEBUG_DIR = path.join(ROOT, 'debug');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const safe = (s) => String(s).replace(/[^\w.-]+/g, '_');

function readMapping() {
  const raw = fs.readFileSync(MAP_PATH, 'utf8');
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    throw new Error('mapping.json не валиден как JSON');
  }
  if (!Array.isArray(data)) throw new Error('mapping.json должен быть массивом объектов');
  return data;
}

function parsePriceRUB(text) {
  if (!text) return null;
  const m = text.replace(/\s/g, '').match(/([\d.,]+)₽/i);
  if (!m) return null;
  const num = m[1].replace(',', '.');
  const v = Number(num);
  return Number.isFinite(v) ? v : null;
}

async function dismissBanners(page) {
  const selectors = [
    'button:has-text("Понятно")',
    'button:has-text("Окей")',
    'button:has-text("Принять")',
    'button:has-text("Accept")',
    'button:has-text("OK")',
  ];
  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn) {
      try { await btn.click({ timeout: 1000 }); } catch {}
    }
  }
}

async function scrapeFunpayPage(browser, url, keyForScreenshot) {
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await dismissBanners(page);

    // Ждём таблицу
    await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(1200);

    // Основной способ: взять последние ячейки (колонка "Цена")
    const rows = await page.$$('table tbody tr');
    const prices = [];
    for (const row of rows) {
      const priceCell =
        (await row.$(':scope td:last-child span')) ||
        (await row.$(':scope td:last-child'));
      const txt = priceCell ? (await priceCell.textContent())?.trim() : '';
      const p = parsePriceRUB(txt || '');
      if (p != null) prices.push(p);
      if (prices.length >= 5) break;
    }

    // Фолбэк: любой текст с "₽"
    if (prices.length === 0) {
      const nodes = await page.$$(':text(/₽/i)');
      for (const n of nodes) {
        const t = (await n.textContent())?.trim() || '';
        const p = parsePriceRUB(t);
        if (p != null) prices.push(p);
        if (prices.length >= 5) break;
      }
    }

    // Скриншот для дебага (видно, что реально видит Playwright)
    try {
      if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
      await page.screenshot({ path: path.join(DEBUG_DIR, `${safe(keyForScreenshot)}.png`), fullPage: true });
    } catch {}

    if (prices.length === 0) {
      return { price_RUB: 0, trades_top5: [] };
    }
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    return {
      price_RUB: Number(avg.toFixed(2)),
      trades_top5: prices.map(p => ({ price_RUB: p }))
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const mapping = readMapping();
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const pairs = {};
  try {
    for (const item of mapping) {
      const key = item.key;
      if (!key || !item.funpay_url) {
        console.log('Пропуск (нет key/url):', item);
        continue;
      }
      console.log(`→ Скрейплю: ${key}  ${item.funpay_url}`);
      let result = { price_RUB: 0, trades_top5: [] };
      try {
        result = await scrapeFunpayPage(browser, item.funpay_url, key);
      } catch (e) {
        console.warn(`   Ошибка для ${key}:`, e.message);
      }

      pairs[key] = {
        game: item.game || null,
        currency: item.currency || null,
        price_RUB: result.price_RUB || 0,
        change_24h: null,
        change_7d: null,
        updated_at: nowIso(),
        trades_top5: result.trades_top5 || []
      };
    }

    const out = { updated_at: nowIso(), source: 'funpay', pairs };
    fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), 'utf8');
    console.log('✔ rates.json сохранён:', OUT_PATH);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
