// scripts/build.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// --- пути ---
const ROOT_DIR     = path.resolve(__dirname, '..');
const OUT_DIR      = path.resolve(ROOT_DIR, 'public');
const OUT_FILE     = path.join(OUT_DIR, 'rates.json');
const MAPPING_FILE = path.resolve(ROOT_DIR, 'mapping.json');
const DEBUG_DIR    = path.resolve(ROOT_DIR, 'debug');

// --- тайминги ---
const NAV_TIMEOUT_MS   = 60_000; // страница/навигация
const PRICE_WAIT_MS    = 15_000; // ожидание цен
const GLOBAL_TIMEOUT_MS= 90_000; // на одну пару

// --- селекторы для цен (в порядке предпочтения) ---
const PRICE_SELECTORS = [
  'table.tc-table .tc-item .tc-price',
  'table.tc-table .tc-price',
  '.tc-item .tc-price',
  '.tc-price',
];

// ---------- helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function safeName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9._-]+/gi, '_');
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

function parseRub(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/\u00A0/g, ' ')      // NBSP -> space
    .replace(/[^\d.,]/g, '')      // только цифры/разделители
    .replace(',', '.');
  const m = cleaned.match(/\d+(?:\.\d+)?/);
  const num = m ? parseFloat(m[0]) : NaN;
  return Number.isFinite(num) ? num : null;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function clickCookiesIfAny(page) {
  const selectors = [
    '#cookiescript_accept',
    '.fc-cta-consent',
    'button:has-text("Согласен")',
    'button:has-text("Принять")',
  ];
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    try { await el.click({ timeout: 1500 }); break; } catch {}
  }
}

async function takeShot(page, key, tag = 'ok') {
  try {
    await ensureDir(DEBUG_DIR);
    const name = `${safeName(key)}-${tag}.png`;
    await page.screenshot({ path: path.join(DEBUG_DIR, name), fullPage: true });
  } catch {}
}

async function waitForAny(page, selectors, { state = 'visible', timeout = PRICE_WAIT_MS } = {}) {
  const endAt = Date.now() + timeout;
  for (const sel of selectors) {
    const t = Math.max(500, endAt - Date.now());
    if (t <= 0) break;
    try {
      await page.waitForSelector(sel, { state, timeout: t });
      return sel;
    } catch {}
  }
  throw new Error(`Не дождался селекторов: ${selectors.join(' | ')}`);
}

async function grabTopPrices(page, topN) {
  for (const sel of PRICE_SELECTORS) {
    const list = page.locator(sel);
    const count = await list.count().catch(() => 0);
    if (!count) continue;

    const nums = [];
    const lim = Math.min(count, Math.max(5, topN)); // берем побольше для надежности
    for (let i = 0; i < lim; i++) {
      const t = await list.nth(i).innerText().catch(() => null);
      const n = parseRub(t);
      if (n !== null) nums.push(n);
    }
    if (nums.length) return nums;
  }
  return [];
}

async function maybeSelectLeague(page, wanted) {
  if (!wanted) return;

  // очень осторожный/опциональный выбор через UI — если не найдет, тихо идем дальше
  try {
    const title = page.locator('.ui-select__title, .select__title').first();
    await title.click({ timeout: 2000 });
    const opt = page.locator('.ui-select__option, .select__option').filter({ hasText: wanted }).first();
    await opt.click({ timeout: 2000 });
    await sleep(600);
  } catch {}
}

// ---------- парсеры ----------
async function parseLotsPage(page, key, avgTop) {
  // дождаться таблицы/строк/цен
  try {
    await waitForAny(page, ['table.tc-table', '.tc-item'], { state: 'attached', timeout: PRICE_WAIT_MS });
  } catch {
    // Иногда лениво подгружается — слегка проскроллим
    await page.evaluate(() => window.scrollBy(0, 600));
    await waitForAny(page, ['table.tc-table', '.tc-item'], { state: 'attached', timeout: PRICE_WAIT_MS });
  }

  const prices = await grabTopPrices(page, avgTop);
  if (!prices.length) throw new Error('Нет видимых цен');

  return {
    price: +avg(prices.slice(0, avgTop)).toFixed(2),
    tops: prices.slice(0, 5).map(n => +n.toFixed(2)),
  };
}

async function parseChipsPage(page, key, avgTop) {
  // Для /chips/ каталога тоже часто встречается .tc-price,
  // поэтому используем тот же механизм ожидания/сбора.
  await waitForAny(page, PRICE_SELECTORS, { state: 'visible', timeout: PRICE_WAIT_MS });
  const prices = await grabTopPrices(page, avgTop);
  if (!prices.length) throw new Error('Нет видимых цен');

  return {
    price: +avg(prices.slice(0, avgTop)).toFixed(2),
    tops: prices.slice(0, 5).map(n => +n.toFixed(2)),
  };
}

// ---------- main ----------
const mapping = JSON.parse(await readFile(MAPPING_FILE, 'utf8'));
await ensureDir(OUT_DIR);
await ensureDir(DEBUG_DIR);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1366, height: 900 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
});

const output = { updated_at: new Date().toISOString(), source: 'funpay', pairs: {} };

for (const cfg of mapping) {
  const key = cfg.key;
  const startTs = Date.now();
  const one = {
    game: cfg.game,
    currency: cfg.currency,
    price_RUB: 0,
    change_24h: null,
    change_7d: null,
    updated_at: null,
    trades_tops: [],
    error: null,
  };

  try {
    const url = cfg.funpay_url || cfg.fallback_root || '';
    if (!url) throw new Error('Не задан funpay_url');

    // Навигация
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await clickCookiesIfAny(page);
    await sleep(400);

    // Попробуем переключить нужную лигу/сервер (если указана)
    await maybeSelectLeague(page, cfg.league);

    // Выбор парсера по типу урла
    const isChips = /\/chips\//i.test(url);
    const avgTop = Math.max(1, cfg.avg_top ?? 3);

    const res = isChips
      ? await parseChipsPage(page, key, avgTop)
      : await parseLotsPage(page, key, avgTop);

    one.price_RUB  = res.price;
    one.trades_tops = res.tops;
    one.updated_at = new Date().toISOString();
    await takeShot(page, key, 'ok');
  } catch (e) {
    one.error = String(e?.message || e);
    await takeShot(page, key, 'error');
  }

  output.pairs[key] = one;

  // маленький «дыхательный» промежуток, чтобы не спамить
  if (Date.now() - startTs < 1200) await sleep(1200);
}

await writeFile(OUT_FILE, JSON.stringify(output, null, 2), 'utf8');
await browser.close();

console.log(`DONE -> ${OUT_FILE}`);
