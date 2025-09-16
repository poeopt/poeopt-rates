// scripts/build.mjs
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- настройки ----------
const OUT_DIR  = path.resolve(__dirname, '../public');
const OUT_FILE = path.join(OUT_DIR, 'rates.json');

const NAV_TIMEOUT_MS   = 60_000; // навигация/загрузка страницы
const PRICE_WAIT_MS    = 25_000; // ожидание появления цены
const GLOBAL_TIMEOUT_MS = 90_000; // на один парс одного урла

// читаем mapping.json из КОРНЯ репозитория
const MAPPING_PATH = path.resolve(__dirname, '../mapping.json');

// ---------- утилиты ----------

/** Нормализуем текст цены в число RUB */
function parseRubNumber(txt) {
  if (!txt) return NaN;
  // оставляем цифры, запятую и точку
  let cleaned = txt.replace(/[^\d.,]/g, '').trim();
  // если есть и запятая, и точка — убираем тысячные
  if (cleaned.includes(',') && cleaned.includes('.')) {
    // предположим, что разделитель дроби — запятая
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    // одна запятая = десятичный разделитель
    cleaned = cleaned.replace(',', '.');
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/** Среднее по массиву чисел; с округлением до 2 знаков (если понадобится) */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Жмём по цене в шапке таблицы, чтобы сортировать по возрастанию */
async function ensureSortByPriceAsc(page) {
  // на разных страницах разная разметка; используем несколько вариантов
  const candidates = [
    // общий вид сортируемого заголовка
    page.locator('.tc-sort').filter({ hasText: /цена/i }),
    // колонка с ценой в шапке
    page.locator('.tc-header .tc-price, .tc-head .tc-price'),
    // запасной вариант — просто заголовок, где есть «Цена»
    page.getByText(/^Цена/i)
  ];

  for (const loc of candidates) {
    try {
      const count = await loc.count();
      if (count > 0) {
        await loc.first().click({ timeout: 2_000 }).catch(() => {});
        // небольшой даунтайм, чтобы пересортировалось
        await page.waitForTimeout(500);
        break;
      }
    } catch {}
  }
}

/** Выбираем лигу/сервер в первом селекте, если нужно */
async function applyLeagueIfNeeded(page, leagueText) {
  if (!leagueText) return;

  // первый селект на странице — это выбор сервера/лиги
  const trigger = page.locator('.tc-select').first();
  await trigger.waitFor({ state: 'visible', timeout: PRICE_WAIT_MS });

  // если уже выбран нужный — ничего не делаем
  const current = await trigger.textContent();
  if (current && current.trim().includes(leagueText)) return;

  await trigger.click().catch(() => {});
  // элементы списка селекта
  const item = page.locator('.tc-select__list .tc-select__item').filter({ hasText: leagueText }).first();
  await item.waitFor({ state: 'visible', timeout: PRICE_WAIT_MS });
  await item.click();
  // подождём перерисовку/перезагрузку офферов
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(300);
}

/** Считываем первые topN видимых цен из таблицы */
async function grabTopPrices(page, topN) {
  const prices = [];
  // выбираем ВИДИМЫЕ строки без класса hidden
  const rows = page.locator('.tc-table .tc-item:not(.hidden)');
  await rows.first().waitFor({ state: 'visible', timeout: PRICE_WAIT_MS });

  const count = Math.min(await rows.count(), topN);
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const priceCell = row.locator('.tc-price:visible').first();

    // ждём видимость конкретной ячейки (не «первой попавшейся» на странице)
    await priceCell.waitFor({ state: 'visible', timeout: PRICE_WAIT_MS });
    const txt = (await priceCell.textContent()) ?? '';
    const val = parseRubNumber(txt);

    if (Number.isFinite(val)) prices.push(round2(val));
  }

  // если выше не получилось (редкие случаи) — запасной способ из DOM
  if (prices.length === 0) {
    const backup = await page.evaluate((maxN) => {
      const out = [];
      const rows = Array.from(document.querySelectorAll('.tc-table .tc-item'))
        .filter(r => !r.classList.contains('hidden'))
        .slice(0, maxN);

      for (const r of rows) {
        const el = r.querySelector('.tc-price');
        if (!el) continue;
        out.push(el.textContent || '');
      }
      return out;
    }, topN);

    for (const t of backup) {
      const v = parseRubNumber(t);
      if (Number.isFinite(v)) prices.push(round2(v));
    }
  }

  return prices;
}

// ---------- основной скрипт ----------

async function main() {
  const mapping = JSON.parse(await readFile(MAPPING_PATH, 'utf8'));

  // браузер
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });

  // чуть ускорим: картинки/шрифты не нужны
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'font' || type === 'media') {
      return route.abort();
    }
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

    try {
      await page.goto(funpay_url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
      // ждём таблицу с офферами
      await page.waitForSelector('.tc-table', { timeout: NAV_TIMEOUT_MS });

      // применяем нужную лигу (если указана)
      if (league) {
        await applyLeagueIfNeeded(page, league);
      }

      // сортируем по цене (по возрастанию)
      await ensureSortByPriceAsc(page);

      // забираем верхние цены
      const top = await grabTopPrices(page, Math.max(1, Number(avg_top) || 1));
      pair.trades_tops = top;
      pair.price_RUB   = top.length ? top[0] : 0;
      pair.updated_at  = new Date().toISOString();
    } catch (e) {
      pair.error = String(e?.message || e);
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
