// scripts/build.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readFile,
  writeFile,
  mkdir,
  access,
  constants as FS_CONSTS,
} from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ===== ПУТИ В РЕПО =====
const OUT_DIR   = path.resolve(__dirname, '../public');
const OUT_FILE  = path.join(OUT_DIR, 'rates.json');
const DEBUG_DIR = path.resolve(__dirname, '../debug');

// ===== ТАЙМАУТЫ =====
const NAV_TIMEOUT_MS    = 60_000;  // загрузка страницы
const TABLE_WAIT_MS     = 15_000;  // ожидание появления таблицы/элементов
const PRICE_WAIT_MS     = 25_000;  // ожидание значения цены для ряда

// ===== СЕЛЕКТОРЫ КАНДИДАТЫ ДЛЯ ЦЕНЫ =====
const PRICE_SELECTORS = [
  '.tc-item .tc-price span.price', // основной
  'td.tc-price .price',
  '.tc-price .price',
];

// ===== ХЕЛПЕРЫ =====
const safeName = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/gi, '_');

function parseRUB(text) {
  if (!text) return null;
  // Убираем всё лишнее, запятую → точку
  const cleaned = String(text).replace(/[^\d.,]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? Number(n) : null;
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function fileExists(p) {
  try { await access(p, FS_CONSTS.F_OK); return true; } catch { return false; }
}

async function readMapping() {
  // 1) корень репозитория
  const root = path.resolve(__dirname, '../mapping.json');
  if (await fileExists(root)) {
    const raw = await readFile(root, 'utf8');
    return JSON.parse(raw);
  }
  // 2) рядом со скриптом (fallback)
  const local = path.resolve(__dirname, './mapping.json');
  if (await fileExists(local)) {
    const raw = await readFile(local, 'utf8');
    return JSON.parse(raw);
  }
  throw new Error('mapping.json не найден ни в корне, ни в scripts/');
}

async function scrapePair(page, pair) {
  const base = safeName(pair.key);
  const result = {
    game: pair.game,
    currency: pair.currency,
    price_RUB: 0,
    change_24h: null,
    change_7d: null,
    updated_at: null,
    trades_tops: [],
    error: null,
  };

  try {
    await page.goto(pair.funpay_url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });

    // ждём таблицу/строки хотя бы одним из вариантов
    const tableOrRow = page.locator('.tc-table, .tc-item, table');
    await tableOrRow.waitFor({ timeout: TABLE_WAIT_MS });

    // найдём первые 5 видимых строк с ценой
    let prices = [];

    // Сначала пытаемся через строки .tc-item
    const rowCount = await page.locator('.tc-item').count();
    const rowsToRead = Math.min(rowCount || 0, 5);
    for (let i = 0; i < rowsToRead; i++) {
      let priceText = null;
      for (const sel of PRICE_SELECTORS) {
        const loc = page.locator(`.tc-item >> nth=${i}`).locator(sel);
        try {
          await loc.first().waitFor({ timeout: PRICE_WAIT_MS });
          const t = await loc.first().textContent();
          if (t && t.trim()) { priceText = t.trim(); break; }
        } catch { /* продолжаем пробовать другой селектор */ }
      }
      const n = parseRUB(priceText);
      if (n !== null) prices.push(n);
    }

    // Если строки не нашли — пробуем просто первые 5 по глобальным селекторам
    if (prices.length === 0) {
      for (const sel of PRICE_SELECTORS) {
        const loc = page.locator(sel);
        const cnt = await loc.count();
        if (cnt > 0) {
          const take = Math.min(cnt, 5);
          for (let i = 0; i < take; i++) {
            const txt = (await loc.nth(i).textContent())?.trim() || '';
            const n = parseRUB(txt);
            if (n !== null) prices.push(n);
          }
          if (prices.length) break;
        }
      }
    }

    // итог
    result.trades_tops = prices;
    result.price_RUB   = prices[0] ?? 0;
    result.updated_at  = new Date().toISOString();

    // успех → скриншот
    await page.screenshot({ path: path.join(DEBUG_DIR, `${base}-ok.png`) });

  } catch (err) {
    result.error      = String(err?.message || err);
    result.updated_at = new Date().toISOString();

    // стараться сохранить и скрин, и html
    try { await page.screenshot({ path: path.join(DEBUG_DIR, `${base}-error.png`) }); } catch {}
    try { await writeFile(path.join(DEBUG_DIR, `${base}.html`), await page.content(), 'utf8'); } catch {}
  }

  return result;
}

async function main() {
  await ensureDir(OUT_DIR);
  await ensureDir(DEBUG_DIR);

  const mapping = await readMapping();

  const out = {
    updated_at: new Date().toISOString(),
    source: 'funpay',
    pairs: {},
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
  });
  const page = await context.newPage();

  for (const pair of mapping) {
    out.pairs[pair.key] = await scrapePair(page, pair);
    // небольшая пауза между запросами, чтобы не троттлить
    await page.waitForTimeout(800);
  }

  await browser.close();

  // сохраняем JSON
  await writeFile(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');
  console.log('DONE:', OUT_FILE);
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  try {
    await writeFile(OUT_FILE, JSON.stringify({
      updated_at: new Date().toISOString(),
      source: 'funpay',
      pairs: {},
      error: String(e?.message || e)
    }, null, 2), 'utf8');
  } catch {}
  process.exit(1);
});
