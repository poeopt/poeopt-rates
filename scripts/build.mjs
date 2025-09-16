// scripts/build.mjs
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ====== НАСТРОЙКИ ======
const OUT_DIR  = path.resolve(__dirname, '../public');
const OUT_FILE = path.join(OUT_DIR, 'rates.json');
const MAPPING_PATH = path.resolve(__dirname, '../mapping.json');

const NAV_TIMEOUT_MS    = 60_000; // переходы по страницам
const PRICE_WAIT_MS     = 25_000; // ожидание появления цены
const GLOBAL_TIMEOUT_MS = 90_000; // на одну пару

// ====== УТИЛИТЫ ======
function parseRub(text) {
  if (!text) return null;
  // выкидываем всё лишнее, оставляем числа и запятую/точку
  const cleaned = text.replace(/[^\d.,]/g, '').replace(/\s+/g, '');
  if (!cleaned) return null;
  // меняем запятую на точку
  const normalized = cleaned.replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

async function pickPrice(page) {
  // Несколько селекторов на случай, если разметка немного отличается
  const selectors = [
    '.tc-item .tc-price',           // ячейка цены в строке таблицы
    '.tc-price',                    // просто ячейка цены
    'table .tc-item .tc-price',     // запасной вариант
  ];

  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: 'visible', timeout: PRICE_WAIT_MS });
      const raw = await loc.textContent().catch(() => null);
      const num = parseRub(raw);
      if (num !== null && num > 0) return num;
    } catch { /* пробуем следующий селектор */ }
  }
  return null;
}

async function fetchOne(browser, conf) {
  const url = conf.url ?? conf.funpay_url; // совместимость со старой схемой
  const key = conf.key ?? `${conf.game}:${conf.currency}`;

  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  let price = 0;
  let error = null;
  const started = Date.now();

  try {
    if (!url) throw new Error('no url in mapping');

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // иногда помогает – ждём добивки ресурсов и скрываем оффлайн
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.locator('text=Только продавцы онлайн').click({ timeout: 2_000 }).catch(() => {});

    // читаем цену
    const got = await pickPrice(page);
    price = got ?? 0;
  } catch (e) {
    error = String(e?.message || e);
  } finally {
    await ctx.close();
  }

  const updated_at = new Date().toISOString();
  return {
    key,
    data: {
      game: conf.game,
      currency: conf.currency,
      price_RUB: price,
      change_24h: null,
      change_7d: null,
      updated_at,
      trades_top5: [],
      ...(error ? { error } : {}),
    },
  };
}

async function main() {
  const mapping = JSON.parse(await readFile(MAPPING_PATH, 'utf8'));

  const browser = await chromium.launch({ headless: true });

  const pairs = {};
  const tasks = mapping.map(async (conf) => {
    const t = fetchOne(browser, conf);
    const r = await Promise.race([
      t,
      new Promise((_, rej) => setTimeout(() => rej(new Error('global-timeout')), GLOBAL_TIMEOUT_MS))
    ]).catch(e => ({ key: conf.key ?? `${conf.game}:${conf.currency}`, data: {
      game: conf.game,
      currency: conf.currency,
      price_RUB: 0,
      change_24h: null,
      change_7d: null,
      updated_at: new Date().toISOString(),
      trades_top5: [],
      error: String(e?.message || e),
    }}));

    pairs[r.key] = r.data;
  });

  await Promise.all(tasks);
  await browser.close();

  await mkdir(OUT_DIR, { recursive: true });
  const payload = {
    updated_at: new Date().toISOString(),
    source: 'funpay',
    pairs,
  };
  await writeFile(OUT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  console.log('DONE:', OUT_FILE);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
