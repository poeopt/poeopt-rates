// scripts/build.mjs
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- пути вывода ---
const OUT_DIR = path.resolve(__dirname, '../public');
const OUT_FILE = path.join(OUT_DIR, 'rates.json');

// --- таймауты ---
const NAV_TIMEOUT_MS = 90_000;     // на загрузку страницы
const PRICE_WAIT_MS = 20_000;      // ждём появления цен
const ONE_URL_TIMEOUT_MS = 120_000;

// --- где лежит mapping.json (в корне репо) ---
const MAPPING_PATH = path.resolve(__dirname, '../mapping.json');

// --- утилиты ---
function parseRubToNumber(txt) {
  if (!txt) return null;
  const cleaned = txt
    .replace(/\u00A0/g, ' ')
    .replace(/[^\d,.\- ]/g, '')
    .trim();
  if (!cleaned) return null;
  // если и запятая и точка — предполагаем, что разделитель десятичной — запятая
  const normalized = cleaned.includes(',') && cleaned.includes('.')
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function nowIso() {
  return new Date().toISOString();
}

function safeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function saveDebug(page, key, stage) {
  try {
    const base = `${safeName(key)}-${stage}`;
    await mkdir('debug', { recursive: true });
    await page.screenshot({ path: path.join('debug', `${base}.png`), fullPage: true });
    const html = await page.content();
    await writeFile(path.join('debug', `${base}.html`), html, 'utf8');
  } catch { /* ignore */ }
}

// Основной парсер для одной страницы Funpay.
// Берём первые 5 строк (.tc-item) у которых в первой колонке содержится нужная лига/сезон.
// Из каждой строки вытаскиваем цену из .tc-price.
async function scrapeTop5Prices(page, entry) {
  const url = entry.funpay_url;
  const leagueWanted = (entry.league || '').trim().toLowerCase();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

  // страница подгружает список — ждём появления строк
  try {
    await page.waitForSelector('.tc-item .tc-price', { state: 'visible', timeout: PRICE_WAIT_MS });
  } catch (e) {
    await saveDebug(page, entry.key, 'no-prices');
    throw new Error(`Не дождался селекторов: .tc-item .tc-price`);
  }

  // Собираем до ~80 строк, чтобы потом отфильтровать по нужной лиге и взять первые 5
  const rows = await page.$$eval('.tc-item', (nodes) => {
    return nodes.slice(0, 80).map((row) => {
      // название лиги/сервера/цикла — обычно в первой колонке,
      // на странице она визуально слева; в разметке есть разные классы —
      // пробуем набор типовых.
      const leagueEl =
        row.querySelector('.tc-server') ||
        row.querySelector('[class*=server]') ||
        row.querySelector('[class*=cycle]') ||
        row.querySelector('[class*=league]') ||
        row.querySelector('[class*=realm]') ||
        row; // запасной вариант: весь текст

      const leagueText = leagueEl?.textContent?.trim() || '';

      const priceEl =
        row.querySelector('.tc-price') ||
        row.querySelector('[class*=price]');

      const priceText = priceEl?.textContent?.trim() || '';

      return {
        leagueText,
        priceText,
      };
    });
  });

  if (!rows.length) {
    await saveDebug(page, entry.key, 'empty-rows');
    throw new Error('Список пуст (tc-item не найдены)');
  }

  // Фильтрация по нужной лиге/сезону (без кликов по фильтрам).
  // Если в mapping лигу не указали — берём всё как есть.
  const filtered = rows.filter((r) => {
    if (!leagueWanted) return true;
    return r.leagueText.toLowerCase().includes(leagueWanted);
  });

  // Парсим цены и берём первые 5 по порядку на странице.
  const top5 = filtered
    .map((r) => parseRubToNumber(r.priceText))
    .filter((n) => Number.isFinite(n))
    .slice(0, 5);

  if (!top5.length) {
    await saveDebug(page, entry.key, 'filtered-no-prices');
    throw new Error(`По лиге "${entry.league}" не нашли цен`);
  }

  return top5;
}

async function main() {
  const mapping = JSON.parse(await readFile(MAPPING_PATH, 'utf8'));

  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
    viewport: { width: 1366, height: 950 },
  });

  const result = {
    updated_at: nowIso(),
    source: 'funpay',
    pairs: {},
  };

  for (const entry of mapping) {
    const page = await ctx.newPage();
    page.setDefaultTimeout(ONE_URL_TIMEOUT_MS);

    const base = {
      game: entry.game,
      currency: entry.currency,
      price_RUB: 0,
      change_24h: null,
      change_7d: null,
      updated_at: null,
      trades_top5: [],
      error: null,
    };

    try {
      const top5 = await scrapeTop5Prices(page, entry);
      base.trades_top5 = top5;
      base.price_RUB = top5[0] ?? 0;
      base.updated_at = nowIso();
    } catch (e) {
      base.error = String(e.message || e);
    } finally {
      result.pairs[entry.key] = base;
      await page.close();
    }
  }

  await browser.close();

  await writeFile(OUT_FILE, JSON.stringify(result, null, 2), 'utf8');
  console.log('DONE:', OUT_FILE);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
