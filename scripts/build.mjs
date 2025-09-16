// scripts/build.mjs
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- пути вывода ----------
const OUT_DIR  = path.resolve(__dirname, '../public');
const OUT_FILE = path.join(OUT_DIR, 'rates.json');

// ---------- тайминги ----------
const NAV_TIMEOUT_MS     = 60_000;  // загрузка страницы
const PRICE_WAIT_MS      = 30_000;  // ожидания внутри страницы
const GLOBAL_TIMEOUT_MS  = 90_000;  // лимит на 1 страницу

// читаем mapping.json из КОРНЯ репозитория
const MAPPING_PATH = path.resolve(__dirname, '../mapping.json');

// флаг отладки (скриншоты в ./debug)
const DEBUG = process.env.DEBUG === '1';

// ---------- утилиты ----------
function parseRubNumber(txt) {
  if (!txt) return NaN;
  let cleaned = String(txt).replace(/[^\d.,]/g, '').trim();
  if (!cleaned) return NaN;

  // если есть и точка, и запятая — уберём разделители тысяч
  if (cleaned.includes('.') && cleaned.includes(',')) {
    // чаще дробь — запятая
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    cleaned = cleaned.replace(',', '.');
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

async function saveDebug(page, key, step = '') {
  if (!DEBUG) return;
  const safe = String(key).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80);
  await mkdir('debug', { recursive: true });
  try { await page.screenshot({ path: `debug/${safe}${step ? '-' + step : ''}.png`, fullPage: true }); } catch {}
}

/** Кликаем по заголовку «Цена», стараясь добиться сортировки по возрастанию */
async function ensureSortByPriceAsc(page) {
  const candidates = [
    '.tc-head .tc-price',          // «новая» шапка
    '.tc-header .tc-price',        // «старая» шапка
    '.tc-sort',                    // обобщённо (есть слово «Цена»)
  ];

  for (const sel of candidates) {
    const loc = page.locator(sel);
    const count = await loc.count().catch(() => 0);
    if (!count) continue;

    try {
      // два клика — чтобы точно поймать направление
      await loc.first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
      await loc.first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
      break;
    } catch {}
  }
}

/** Выбор лиги/сезона/сервера по тексту */
async function applyLeagueIfNeeded(page, leagueText) {
  if (!leagueText) return;

  // На страницах Funpay селекты имеют общий класс tc-select.
  // Пройдёмся по всем — в каком-то из них будет нужная лига.
  const selects = page.locator('.tc-select');
  const n = await selects.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const trigger = selects.nth(i);
    let current = (await trigger.textContent().catch(() => ''))?.trim() || '';
    if (current.includes(leagueText)) return;

    try {
      await trigger.click({ timeout: 1500 });
      const item = page.locator('.tc-select__list .tc-select__item, .tc-select__option')
                       .filter({ hasText: leagueText }).first();
      await item.waitFor({ state: 'attached', timeout: PRICE_WAIT_MS });
      await item.click({ timeout: 1500 });
      // дать странице перегрузить офферы
      await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(400);
      return;
    } catch {
      // закроем дропдаун по ESC, чтобы не мешал следующему селекту
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
}

/** Считываем первые topN цен из DOM (без требования «visible») */
async function grabTopPrices(page, topN) {
  // ждать появления таблицы/строк (без видимости)
  await page.waitForSelector('.tc-table, .tc-item, table', { timeout: PRICE_WAIT_MS });

  // возьмём тексты цен из самых вероятных мест
  const priceTexts = await page.evaluate((maxCount) => {
    const pick = (sel) => Array.from(document.querySelectorAll(sel)).map(e => e.textContent || '');

    // строки без .hidden — приоритетнее
    const fromRows =
      Array.from(document.querySelectorAll('.tc-table .tc-item'))
        .filter(r => !r.classList.contains('hidden'))
        .map(r => (r.querySelector('.tc-price')?.textContent) || '');

    const union = [
      ...fromRows,
      ...pick('.tc-table .tc-item .tc-price'),
      ...pick('td.tc-price'),
      ...pick('.tc-price')
    ].filter(Boolean);

    // отдаём немного с запасом — парсер отфильтрует нечисловые
    return union.slice(0, Math.max(maxCount * 3, maxCount));
  }, topN);

  const nums = [];
  for (const t of priceTexts) {
    const v = parseRubNumber(t);
    if (Number.isFinite(v)) {
      nums.push(v);
      if (nums.length >= topN) break;
    }
  }
  return nums;
}

// ---------- основной скрипт ----------
async function main() {
  const mapping = JSON.parse(await readFile(MAPPING_PATH, 'utf8'));

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });

  // Ускорим загрузку: блокируем тяжёлое
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'font' || type === 'media') return route.abort();
    route.continue();
  });

  const result = {
    updated_at: new Date().toISOString(),
    source: 'funpay',
    pairs: {}
  };

  for (const cfg of mapping) {
    const { key, game, currency, funpay_url, league = '', avg_top = 5 } = cfg;

    const pair = {
      game,
      currency,
      price_RUB: 0,
      change_24h: null,
      change_7d: null,
      updated_at: null,
      trades_tops: [],
      error: null
    };

    const page = await context.newPage();
    const startTs = Date.now();

    try {
      await page.goto(funpay_url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(300);

      await saveDebug(page, key, '01-open');

      // выбранная лига/сезон
      if (league) {
        await applyLeagueIfNeeded(page, league);
        await saveDebug(page, key, '02-league');
      }

      // на всякий случай попробуем отсортировать по цене (вверх)
      await ensureSortByPriceAsc(page);
      await saveDebug(page, key, '03-sort');

      // получить верхние цены
      const top = await grabTopPrices(page, Math.max(1, Number(avg_top) || 1));
      pair.trades_tops = top;
      pair.price_RUB   = top.length ? top[0] : 0;
      pair.updated_at  = new Date().toISOString();

      // если за отведённое время ничего не собрали — пробуем рефреш 1 раз
      if (!top.length && Date.now() - startTs < GLOBAL_TIMEOUT_MS - 5_000) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
        const top2 = await grabTopPrices(page, Math.max(1, Number(avg_top) || 1));
        pair.trades_tops = top2;
        pair.price_RUB   = top2.length ? top2[0] : 0;
        pair.updated_at  = new Date().toISOString();
        await saveDebug(page, key, '04-retry');
      }
    } catch (e) {
      pair.error = String(e?.message || e);
      await saveDebug(page, key, 'error');
    } finally {
      await page.close().catch(() => {});
    }

    result.pairs[key] = pair;
  }

  await browser.close().catch(() => {});
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(result, null, 2), 'utf8');

  console.log(`DONE: ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
