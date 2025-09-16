// scripts/build.mjs
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// === ПУТИ ===
const OUT_DIR = path.resolve(__dirname, '../public');
const OUT_FILE = path.join(OUT_DIR, 'rates.json');
const MAPPING_PATH = path.resolve(__dirname, '../mapping.json');
const DEBUG_DIR = path.resolve(__dirname, '../debug');

// === ТАЙМАУТЫ ===
const NAV_TIMEOUT_MS = 60_000;         // навигация/перезагрузка
const TABLE_TIMEOUT_MS = 15_000;       // ожидание появления списка/таблицы
const PRICE_TIMEOUT_MS = 8_000;        // ожидание 1-й цены
const AFTER_FILTER_MS = 1_000;         // пауза после выбора лиги/фильтра
const RETRIES = 2;                     // сколько раз переcпробовать пару при неудаче

// === УТИЛИТЫ ===
function rubToNumber(text) {
  if (!text) return null;
  // вычищаем пробелы/узкие пробелы/неразрывные, «₽», и заменяем запятую на точку
  const cleaned = text
    .replace(/\s| | /g, '')
    .replace(/[₽р]/gi, '')
    .replace(',', '.')
    .trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

async function ensureDir(p) {
  try { await mkdir(p, { recursive: true }); } catch {}
}

async function saveDebug(page, slug, stage) {
  try {
    await ensureDir(DEBUG_DIR);
    await page.screenshot({ path: path.join(DEBUG_DIR, `${slug}_${stage}.png`), fullPage: true });
    const html = await page.content();
    await writeFile(path.join(DEBUG_DIR, `${slug}_${stage}.html`), html);
  } catch {}
}

function avg(arr) {
  if (!arr.length) return 0;
  return Math.round((arr.reduce((a,b)=>a+b,0) / arr.length) * 100) / 100;
}

/**
 * Выбор лиги/сезона на страницах с Selectize (PoE/PoE2).
 * Работает так:
 *  - кликаем по инпуту ('.selectize-input')
 *  - ждём выпадающий список ('.selectize-dropdown-content')
 *  - кликаем по опции с нужным текстом
 */
async function chooseLeagueIfNeeded(page, leagueText) {
  if (!leagueText) return;
  // иногда на странице несколько контролов — берём первый «Лига»
  const input = page.locator('.selectize-control .selectize-input').first();
  if (await input.count() === 0) return;

  await input.click({ timeout: TABLE_TIMEOUT_MS });
  const dropdown = page.locator('.selectize-dropdown .selectize-dropdown-content');
  await dropdown.waitFor({ state: 'visible', timeout: TABLE_TIMEOUT_MS });

  // ищем опцию по полному тексту; если не нашли — пробуем contains
  const exact = dropdown.locator('.option', { hasText: leagueText });
  if (await exact.count()) {
    await exact.first().click();
  } else {
    const contains = dropdown.locator('.option');
    const cnt = await contains.count();
    for (let i = 0; i < cnt; i++) {
      const t = (await contains.nth(i).innerText()).trim();
      if (t.includes(leagueText)) { await contains.nth(i).click(); break; }
    }
  }
  await page.waitForTimeout(AFTER_FILTER_MS);
}

/**
 * Сбор первых N цен со страницы. Для "chips" и "lots" — разные селекторы.
 * Возвращает массив чисел (рубли).
 */
async function collectTopPrices(page, url, topN) {
  const isChips = /\/chips\//.test(url);
  const isLots  = /\/lots\//.test(url);

  // ждём появления основного контейнера
  const readySelector = isChips ? '.tc-item' : 'table.tc-table';
  await page.waitForSelector(readySelector, { state: 'visible', timeout: TABLE_TIMEOUT_MS });

  // основной перечень кандидатов в зависимости от типа страницы
  let priceLoc;
  if (isChips) {
    priceLoc = page.locator('.tc-item .tc-price:visible');
  } else {
    // на валютных страницах цена — в ячейке .tc-price таблицы
    priceLoc = page.locator('table.tc-table td.tc-price:visible, table.tc-table td.tc-price *:visible');
  }

  await priceLoc.first().waitFor({ state: 'visible', timeout: PRICE_TIMEOUT_MS })
    .catch(() => {/* пусть упадёт далее с пустым массивом */});

  // Собираем максимум 3*N элементов, чтобы отфильтровать мусор, и берём верхние N валидных.
  const grabCount = Math.max(topN * 3, topN);
  const texts = await priceLoc.allTextContents().then(arr => arr.slice(0, grabCount));

  const numbers = [];
  for (const t of texts) {
    const n = rubToNumber(t);
    if (n !== null) numbers.push(n);
    if (numbers.length >= topN) break;
  }
  return numbers.slice(0, topN);
}

/**
 * Обработка одной пары.
 */
async function handlePair(page, pair) {
  const { key, game, currency, funpay_url, league, avg_top = 5 } = pair;
  const slug = key.replace(/[^a-z0-9_-]+/gi, '_');

  const result = {
    [key]: {
      game, currency,
      price_RUB: 0,
      change_24h: null,
      change_7d: null,
      updated_at: null,
      trades_tops: [],
      error: null,
    }
  };

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      // Навигация (forceReload для повторов)
      if (attempt === 0) {
        await page.goto(funpay_url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      } else {
        await page.goto(funpay_url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(()=>{});
      }

      // Выбор лиги/сезона (если указан)
      await chooseLeagueIfNeeded(page, league);

      // Минимальная синхронизация перед сбором
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(()=>{});

      // Сбор цен
      const tops = await collectTopPrices(page, funpay_url, avg_top);
      if (!tops.length) throw new Error('Нет видимых цен');

      // Усредняем N верхних цен (округляем до копеек)
      const price = avg(tops);

      result[key].price_RUB = price;
      result[key].trades_tops = tops;
      result[key].updated_at = new Date().toISOString();
      result[key].error = null;

      return result; // успех — выходим
    } catch (err) {
      // На последней попытке — сохраняем отладку и пробрасываем ошибку в выдачу
      if (attempt === RETRIES) {
        await saveDebug(page, slug, 'error');
        result[key].error = String(err?.message || err);
        result[key].updated_at = new Date().toISOString();
        return result;
      }
      // небольшая пауза перед повтором
      await page.waitForTimeout(800);
    }
  }

  return result; // теоретически сюда не дойдём
}

async function main() {
  await ensureDir(OUT_DIR);
  await ensureDir(DEBUG_DIR);

  const mapping = JSON.parse(await readFile(MAPPING_PATH, 'utf8'));

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage']
  });

  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'ru-RU',
  });

  const page = await ctx.newPage();

  // открываем главную 1 раз — прогреваем куки и CF
  await page.goto('https://funpay.com/', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    .catch(()=>{});

  const out = { updated_at: new Date().toISOString(), source: 'funpay', pairs: {} };

  for (const pair of mapping) {
    const resObj = await handlePair(page, pair);
    Object.assign(out.pairs, resObj);
  }

  await writeFile(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');

  await browser.close();
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  // попытка сохранить хоть какой-то файл, чтобы страница не пустела
  try {
    await ensureDir(OUT_DIR);
    const fallback = { updated_at: new Date().toISOString(), source: 'funpay', pairs: {}, error: String(e) };
    await writeFile(OUT_FILE, JSON.stringify(fallback, null, 2), 'utf8');
  } catch {}
  process.exit(1);
});
