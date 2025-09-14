// scripts/build.cjs
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = process.cwd();
const MAP_PATH = path.join(ROOT, 'mapping.json');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_PATH = path.join(OUT_DIR, 'rates.json');

// утилиты
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function readMapping() {
  const raw = fs.readFileSync(MAP_PATH, 'utf8');
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    throw new Error('mapping.json не валиден как JSON');
  }
  if (!Array.isArray(data)) {
    throw new Error('mapping.json должен быть массивом объектов');
  }
  return data;
}

function parsePriceRUB(text) {
  // Примеры: "0.99 ₽", "23.02 ₽", "69,04 ₽"
  if (!text) return null;
  const m = text.replace(/\s/g, '').match(/([\d.,]+)₽/i);
  if (!m) return null;
  const num = m[1].replace(',', '.');
  const v = Number(num);
  return Number.isFinite(v) ? v : null;
}

async function scrapeFunpayPage(browser, url) {
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    // чуть-чуть ждём, т.к. у FunPay часть таблицы дорисовывается
    await sleep(1500);

    // Берём все строки основной таблицы (первый листинг)
    const rows = await page.$$(
      'table tbody tr'
    );

    const prices = [];
    for (const row of rows) {
      // в последней/ценовой колонке встречается "Цена ₽"
      const priceCell = await row.$(':scope td:last-child, :scope td .tc:last-child');
      const txt = priceCell ? (await priceCell.textContent())?.trim() : '';
      const price = parsePriceRUB(txt || '');
      if (price !== null) prices.push(price);
      if (prices.length >= 5) break;
    }

    // иногда вёрстка другая — пробуем альтернативный селектор цены
    if (prices.length === 0) {
      const altPrices = await page.$$(':text("₽")');
      for (const el of altPrices) {
        const t = (await el.textContent())?.trim() || '';
        const p = parsePriceRUB(t);
        if (p !== null) prices.push(p);
        if (prices.length >= 5) break;
      }
    }

    // если совсем ничего не нашли — возвращаем пусто
    if (prices.length === 0) {
      return { price_RUB: 0, trades_top5: [] };
    }

    // считаем VWAP (по факту — просто среднее по топ-5 ценам,
    // так как объём не виден без доп.кликов/скролла)
    const avg =
      prices.reduce((a, b) => a + b, 0) / prices.length;

    return {
      price_RUB: Number(avg.toFixed(2)),
      trades_top5: prices.map((p) => ({ price_RUB: p }))
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
        console.log(`Пропускаю элемент без key/url:`, item);
        continue;
      }
      console.log(`→ Скрейплю: ${key}  ${item.funpay_url}`);

      let result = { price_RUB: 0, trades_top5: [] };
      try {
        result = await scrapeFunpayPage(browser, item.funpay_url);
      } catch (e) {
        console.warn(`   Ошибка скрейпа для ${key}:`, e.message);
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

    const out = {
      updated_at: nowIso(),
      source: "funpay",
      pairs
    };

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
