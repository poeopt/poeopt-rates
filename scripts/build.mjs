// scripts/build.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ====== НАСТРОЙКА ====== */
const OUT_DIR  = path.resolve(__dirname, '../public');           // куда класть rates.json
const OUT_FILE = path.join(OUT_DIR, 'rates.json');                // файл с результатом
const MAPPING_PATH = path.resolve(__dirname, '../mapping.json');  // откуда брать список страниц

// таймауты
const NAV_TIMEOUT_MS   = 60_000;  // ожидание загрузки страницы
const PRICE_WAIT_MS    = 45_000;  // ожидание появления цен
const PER_URL_TIMEOUT  = 90_000;  // «максимум» на одну пару

// возможные селекторы цены (делаем запас по вариантам верстки)
const PRICE_SELECTORS = [
  '.tc-price',                // основной
  'td.tc-price',
  'div.tc-price',
  '.tc-item .tc-price',
  'a.tc-price',
  'span.price'
];

/* ====== Утилиты ====== */

function parseRubToNumber(txt) {
  if (!txt) return null;
  // выкидываем «₽», пробелы, нецифры; заменяем запятую на точку
  const cleaned = txt
    .replace(/\s+/g, ' ')
    .replace(/[^\d.,]/g, '')
    .trim()
    .replace(',', '.');
  const num = Number(cleaned.match(/^\d+(?:\.\d+)?/)?.[0] ?? '');
  return Number.isFinite(num) ? num : null;
}

async function ensureOutDir() {
  await mkdir(OUT_DIR, { recursive: true });
}

async function waitForAnySelector(page, selectors, timeout) {
  const start = Date.now();
  for (;;) {
    for (const sel of selectors) {
      const el = page.locator(`${sel}:visible`).first();
      if (await el.count().catch(() => 0)) {
        try {
          await el.waitFor({ state: 'visible', timeout: 1000 });
          return sel; // первый сработавший селектор
        } catch {}
      }
    }
    if (Date.now() - start > timeout) {
      throw new Error(`Timeout ${timeout}ms exceeded while waiting any of selectors: ${selectors.join(', ')}`);
    }
    await page.waitForTimeout(300);
  }
}

/* ====== Парсинг одной страницы ====== */

async function parseFunpayMinPrice(browser, { funpay_url, chips }) {
  const context = await browser.newContext({
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36',
  });
  const page = await context.newPage();

  // анти-детект по webdriver
  await page.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {}
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PER_URL_TIMEOUT);

  try {
    // Загружаем и ждём «дом-контент загружен»
    await page.goto(funpay_url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // чуть-чуть воздуха, потом ждём стабилизации сети
    await page.waitForTimeout(1500);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

    // ждём появления хотя бы одной цены по любому из селекторов
    const usedSelector = await waitForAnySelector(page, PRICE_SELECTORS, PRICE_WAIT_MS);

    // собираем ТЕКСТЫ всех видимых цен в таблице
    const texts = await page.$$eval(usedSelector, (els) =>
      els.map((el) => (el?.textContent || '').trim()).filter(Boolean)
    );

    // приводим к числам и берём минимум
    const nums = texts.map(parseRubToNumber).filter((n) => Number.isFinite(n) && n > 0);
    if (!nums.length) throw new Error(`Не удалось распознать цены. Тексты: ${JSON.stringify(texts.slice(0, 8))}`);

    // ВНИМАНИЕ: если «цена за 1000 единиц», раскомментируй строку ниже
    // const minRub = Math.min(...nums) / (chips || 1);

    const minRub = Math.min(...nums); // если цены уже «за 1»
    return { ok: true, price_RUB: minRub, usedSelector };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(timeout);
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

/* ====== Основной скрипт ====== */

async function main() {
  const mapping = JSON.parse(await readFile(MAPPING_PATH, 'utf8'));

  const result = {
    updated_at: new Date().toISOString(),
    source: 'funpay',
    pairs: {}
  };

  await ensureOutDir();

  const browser = await chromium.launch({ headless: true });
  try {
    for (const item of mapping) {
      const key = item.key;
      const meta = {
        game: item.game,
        currency: item.currency,
        price_RUB: 0,
        change_24h: null,
        change_7d: null,
        updated_at: new Date().toISOString(),
        trades_top5: []
      };

      const r = await parseFunpayMinPrice(browser, item);
      if (r.ok) {
        meta.price_RUB = r.price_RUB;
        meta.used_selector = r.usedSelector;
      } else {
        meta.error = r.error;
      }

      result.pairs[key] = meta;

      // лёгкая пауза, чтобы не долбить сайт
      await new Promise(res => setTimeout(res, 1500));
    }
  } finally {
    await browser.close().catch(() => {});
  }

  await writeFile(OUT_FILE, JSON.stringify(result, null, 2), 'utf8');
  console.log('DONE:', OUT_FILE);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
