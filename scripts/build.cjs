/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'dist');
const DEBUG_DIR = path.join(ROOT, 'debug');
const MAPPING_PATH = path.join(ROOT, 'mapping.json');

function safeFile(name) {
  return String(name).replace(/[^a-z0-9_.-]+/gi, '-');
}

function parsePrice(text) {
  if (!text) return NaN;
  const match = text.replace(/\s+/g, '').match(/([\d.,]+)₽/i);
  if (!match) return NaN;
  return parseFloat(match[1].replace(',', '.'));
}

function parseQty(text) {
  if (!text) return NaN;
  const trimmed = text.replace(/\s+/g, '');
  const mk = trimmed.match(/([\d.,]+)k/i);
  if (mk) return parseFloat(mk[1].replace(',', '.')) * 1000;
  const mn = trimmed.match(/([\d.,]+)/);
  if (mn) return parseFloat(mn[1].replace(',', '.'));
  return NaN;
}

async function saveDebug(page, key, suffix = '') {
  await fs.promises.mkdir(DEBUG_DIR, { recursive: true });
  const file = safeFile(`${key}${suffix}`);
  await fs.promises.writeFile(
    path.join(DEBUG_DIR, `${file}.html`),
    await page.content(),
    'utf8'
  );
  await page.screenshot({ path: path.join(DEBUG_DIR, `${file}.png`) });
}

async function scrapePage(browser, key, url) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    locale: 'ru-RU'
  });
  const page = await context.newPage();

  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!res || !res.ok()) throw new Error(`HTTP ${res ? res.status() : 'no response'}`);

    // Ждём, пока появятся строки с ценами
    await page.waitForFunction(() => {
      const prices = document.querySelectorAll('.tc-table .tc-item .tc-price');
      return Array.from(prices).some(el => /\d/.test(el.textContent || ''));
    }, { timeout: 20000 });

    // Пытаемся отсортировать по цене (если кнопка есть)
    const priceHeader = await page.$('button:has-text("Цена"), .tc-table thead th button:has-text("Price")');
    if (priceHeader) {
      try {
        await priceHeader.click({ timeout: 1500 });
        await page.waitForTimeout(800);
      } catch { /* ignore */ }
    }

    // Забираем первые видимые 5 строк
    const rows = await page.evaluate(() => {
      const r = Array.from(document.querySelectorAll('.tc-table .tc-item'))
        .filter(row => row.offsetParent !== null);
      const out = [];
      for (let i = 0; i < r.length && out.length < 5; i++) {
        const row = r[i];
        const priceEl = row.querySelector('.tc-price') || row.querySelector('[class*="price"]');
        const qtyEl = row.querySelector('.tc-amount, .tc-available, [class*="amount"], [class*="avail"]');
        out.push({
          priceTxt: priceEl ? priceEl.textContent.trim() : '',
          qtyTxt: qtyEl ? qtyEl.textContent.trim() : ''
        });
      }
      return out;
    });

    const offers = rows
      .map(({ priceTxt, qtyTxt }) => ({
        price: parsePrice(priceTxt),
        qty: parseQty(qtyTxt) || 1
      }))
      .filter(o => o.price > 0);

    if (!offers.length) throw new Error('Не удалось найти цены');

    const qtySum = offers.reduce((s, o) => s + o.qty, 0);
    const costSum = offers.reduce((s, o) => s + o.price * o.qty, 0);
    const vwap = costSum / qtySum;

    await saveDebug(page, key);
    await context.close();
    return { ok: true, price: Number(vwap.toFixed(2)), offers };
  } catch (e) {
    console.error(`[${key}] ${e.message}`);
    await saveDebug(page, key, '_error');
    await context.close();
    return { ok: false, price: 0, offers: [], error: e.message };
  }
}

(async () => {
  const raw = await fs.promises.readFile(MAPPING_PATH, 'utf8');
  let mapping;
  try {
    mapping = JSON.parse(raw);
  } catch {
    console.error('mapping.json — невалидный JSON');
    process.exit(1);
  }
  if (!Array.isArray(mapping)) {
    console.error('mapping.json должен быть массивом объектов');
    process.exit(1);
  }

  await fs.promises.mkdir(OUT_DIR, { recursive: true });
  await fs.promises.mkdir(DEBUG_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  });

  const pairs = {};
  for (const item of mapping) {
    const key = item.key;
    const url = item.url || item.funpay_url;
    if (!key || !url) {
      console.error(`Пропуск записи: ${JSON.stringify(item)}`);
      continue;
    }
    const r = await scrapePage(browser, key, url);
    pairs[key] = {
      game: item.game,
      currency: item.currency,
      price_RUB: r.price,
      change_24h: null,
      change_7d: null,
      updated_at: new Date().toISOString(),
      trades_top5: r.offers.map(o => ({ price_RUB: o.price, quantity: o.qty })),
      error: r.ok ? null : r.error || null
    };
  }

  await browser.close();

  const payload = {
    updated_at: new Date().toISOString(),
    source: 'funpay',
    pairs
  };

  await fs.promises.writeFile(path.join(OUT_DIR, 'rates.json'), JSON.stringify(payload, null, 2));

  const indexHtml = `<!doctype html><html lang="ru"><meta charset="utf-8">
<title>poeopt-rates</title>
<style>body{background:#111;color:#ddd;font:16px/1.5 system-ui,Segoe UI,Roboto,Arial;padding:24px}a{color:#8fd}</style>
<h1>poeopt-rates</h1><p>Данные: <a href="./rates.json">rates.json</a></p>`;
  await fs.promises.writeFile(path.join(OUT_DIR, 'index.html'), indexHtml);

  console.log('Готово: dist/rates.json и dist/index.html обновлены');
})();
