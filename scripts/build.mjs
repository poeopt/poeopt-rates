// scripts/build.mjs
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- пути ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const OUT_DIR  = path.resolve(__dirname, '../public');
const OUT_FILE = path.join(OUT_DIR, 'rates.json');

// mаппинг лежит В КОРНЕ
const MAPPING_PATH = path.resolve(__dirname, '../mapping.json');

// директория для скринов (заберётся GitHub Actions шагом "Upload debug artifacts")
const DEBUG_DIR = path.resolve(__dirname, '../debug');

// ---------- настройки ----------
const NAV_TIMEOUT_MS   = 30_000;
const TABLE_WAIT_MS    = 12_000;
const EXTRA_WAIT_MS    = 3_000;
const GLOBAL_TIMEOUT   = 60_000; // на один лот

// ---------- утилиты ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ensureDir(p) {
  return fs.mkdir(p, { recursive: true }).catch(() => {});
}

function parseRUB(txt) {
  if (!txt) return null;
  // убираем всё кроме цифр/разделителей; запятую -> точку
  const cleaned = txt.replace(/[^\d.,]/g, '').replace(',', '.');
  const m = cleaned.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

async function isTableVisible(page, timeout = 4000) {
  try {
    await page.waitForSelector('.tc-table', { state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Открываем прямую ссылку; если нет таблицы/404 — идём на корневую
 * категорию и кликаем по элементу с нужным chips id.
 */
async function openLotOrFallback(page, item, dbgPrefix = 'dbg') {
  const url = item.funpay_url;
  const id  = item.chips;
  const fallbackRoot = item.fallback_root;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  } catch (_) { /* попробуем fallback */ }

  if (await isTableVisible(page, 3500)) return;

  const title = (await page.title().catch(() => ''))?.toLowerCase?.() ?? '';
  const looksBad = title.includes('404') || title.includes('не найдена');
  if ((looksBad || !(await isTableVisible(page, 1500))) && fallbackRoot) {
    try { await page.screenshot({ path: path.join(DEBUG_DIR, `${dbgPrefix}-fallback-start.png`), fullPage: true }); } catch {}

    await page.goto(fallbackRoot, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // Ищем ссылку на нужный лот по id
    // chips: 200/177 -> /chips/<id>/
    // currencies: .../currencies/<id>/
    const sel = `a[href$="/${id}/"]`;
    const idLink = page.locator(sel).first();
    await idLink.waitFor({ state: 'visible', timeout: 10_000 });
    await idLink.click();
    await page.waitForSelector('.tc-table', { state: 'visible', timeout: TABLE_WAIT_MS });
  }
}

/** Считываем top-N цен из таблицы */
async function readTopPrices(page, count = 5) {
  const rows = page.locator('.tc-item');
  const n = Math.min(await rows.count(), count);
  const arr = [];
  for (let i = 0; i < n; i++) {
    const priceCell = rows.nth(i).locator('.tc-price');
    try {
      await priceCell.waitFor({ state: 'visible', timeout: 3000 });
      const txt = await priceCell.textContent();
      const val = parseRUB(txt);
      if (val != null) arr.push(val);
    } catch {}
  }
  return arr;
}

async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

// ---------- основной билд ----------
(async () => {
  await ensureDir(DEBUG_DIR);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    locale: 'ru-RU',
  });
  const page = await context.newPage();

  const mappingRaw = await fs.readFile(MAPPING_PATH, 'utf8');
  const mapping = JSON.parse(mappingRaw);

  const result = {
    updated_at: new Date().toISOString(),
    source: 'funpay',
    pairs: {},
  };

  for (const item of mapping) {
    const key = item.key;
    const startedAt = Date.now();
    const meta = {
      game: item.game,
      currency: item.currency,
      price_RUB: 0,
      change_24h: null,
      change_7d: null,
      updated_at: null,
      trades_tops: [],
      error: null,
    };

    try {
      await openLotOrFallback(page, item, key);
      await page.waitForLoadState('domcontentloaded');

      // иногда таблица появляется, но ценники чуть позже
      await sleep(EXTRA_WAIT_MS);

      if (!(await isTableVisible(page, 1500))) {
        meta.error = 'Нет видимых цен';
      } else {
        const tops = await readTopPrices(page, item.avg_top ?? 5);
        meta.trades_tops = tops;
        meta.price_RUB = tops.length ? tops[0] : 0;
        if (!tops.length) meta.error = 'Нет видимых цен';
      }

      try { await page.screenshot({ path: path.join(DEBUG_DIR, `${key}-final.png`), fullPage: true }); } catch {}
    } catch (err) {
      meta.error = String(err?.message || err);
      try { await page.screenshot({ path: path.join(DEBUG_DIR, `${key}-error.png`), fullPage: true }); } catch {}
    } finally {
      meta.updated_at = new Date().toISOString();

      // страховка от зависаний на один лот
      if (Date.now() - startedAt > GLOBAL_TIMEOUT) {
        meta.error = (meta.error ? meta.error + ' | ' : '') + 'Lot timeout';
      }
      result.pairs[key] = meta;
    }
  }

  await writeJson(OUT_FILE, result);

  await browser.close();
  // выводим путь к результату в лог
  console.log('Wrote:', OUT_FILE);
})().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
});
