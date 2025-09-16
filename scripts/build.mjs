// scripts/build.mjs
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Куда пишем
const OUT_DIR = path.resolve(__dirname, '../public');
const OUT_FILE = path.join(OUT_DIR, 'rates.json');
const DEBUG_DIR = path.resolve(__dirname, '../debug');

// Что парсим
const MAPPING_PATH = path.resolve(__dirname, '../mapping.json');

// Тайминги
const NAV_TIMEOUT_MS = 60_000;
const PRICE_WAIT_MS = 25_000;
const GLOBAL_TIMEOUT_MS = 90_000;
const WAIT_AFTER_SELECT_MS = 1_200;

// ---------- утилиты ----------
function parseRUB(text) {
  if (!text) return NaN;
  const cleaned = String(text)
    .replace(/\u00A0/g, ' ')     // неразрывные пробелы → обычные
    .replace(/[^\d,.\s]/g, '')   // лишние символы
    .trim();

  // убираем пробелы-разделители тысяч и приводим запятую к точке
  const num = cleaned.replace(/\s+/g, '').replace(',', '.');
  const n = Number(num);
  return Number.isFinite(n) ? n : NaN;
}

function avg(arr) {
  if (!arr.length) return NaN;
  return +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
}

/**
 * Попытка выбрать нужную лигу/сервер на странице по точному тексту.
 * Сначала пытаемся через нативный <select>, затем через клик по кастомному дропдауну.
 */
async function smartSelectLeague(page, wantedText) {
  if (!wantedText) return 'skip';

  // 1) Пытаемся найти НАТИВНЫЙ <select> с такой опцией
  const viaSelect = await page.evaluate((label) => {
    const selects = Array.from(document.querySelectorAll('select'));
    for (const s of selects) {
      const opt = Array.from(s.options).find(o => o.textContent.trim() === label);
      if (opt) {
        s.value = opt.value;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, wantedText);

  if (viaSelect) return 'select';

  // 2) Пытаемся кликнуть по кастомному дропдауну
  try {
    // Открываем любой видимый триггер дропа рядом с таблицей
    const togglers = page
      .locator('button,[role="button"],.select,.custom-select,.cs-select,.fc-select')
      .filter({ hasNotText: /Только продавцы онлайн|Only online/i });

    await togglers.first().click({ timeout: 2000 }).catch(() => {});
    await page.getByText(wantedText, { exact: true }).first().click({ timeout: 2000 });
    return 'click';
  } catch {
    // 3) Последняя попытка — клик прямо по тексту (вдруг пункты видимы постоянно)
    try {
      await page.getByText(wantedText, { exact: true }).first().click({ timeout: 2000 });
      return 'click2';
    } catch {
      return 'fail';
    }
  }
}

async function grabTopPrices(page, limit = 8) {
  // ждём, пока появятся строки
  await page.waitForSelector('.tc-item', { timeout: PRICE_WAIT_MS });
  const raw = await page.$$eval('.tc-item .tc-price', els =>
    els.slice(0, 20).map(e => e.textContent)
  );
  const nums = raw.map(parseRUB).filter(n => Number.isFinite(n) && n > 0);
  return nums.slice(0, limit);
}

async function collectPair(page, cfg) {
  const result = {
    game: cfg.game,
    currency: cfg.currency,
    price_RUB: 0,
    change_24h: null,
    change_7d: null,
    updated_at: new Date().toISOString(),
    trades_top5: [],
    error: null
  };

  try {
    await page.goto(cfg.funpay_url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });

    if (cfg.league) {
      await smartSelectLeague(page, cfg.league);
      await page.waitForTimeout(WAIT_AFTER_SELECT_MS);
    }

    // гарантируем, что хотя бы одна цена видна
    await page.waitForSelector('.tc-item .tc-price', { timeout: PRICE_WAIT_MS });

    const top = await grabTopPrices(page, 5);
    result.trades_top5 = top.map(v => +v.toFixed(2));

    if (top.length) {
      const n = Math.max(1, Math.min(cfg.avg_top ?? 3, top.length)); // по умолчанию среднее первых 3
      result.price_RUB = avg(top.slice(0, n));
    } else {
      result.error = 'prices_not_found';
    }
  } catch (e) {
    result.error = String(e?.message ?? e);
  }

  // Скрин дебага (даже если упало)
  try {
    await mkdir(DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: path.join(DEBUG_DIR, `${cfg.key || `${cfg.game}-${cfg.currency}`}.png`), fullPage: true });
  } catch {}

  return result;
}

async function main() {
  const mapping = JSON.parse(await readFile(MAPPING_PATH, 'utf-8'));

  const browser = await chromium.launch({ headless: true, timeout: GLOBAL_TIMEOUT_MS });
  const page = await browser.newPage();

  const out = {
    updated_at: new Date().toISOString(),
    source: 'funpay',
    pairs: {}
  };

  for (const cfg of mapping) {
    const key = cfg.key ?? `${cfg.game}:${cfg.currency}`;
    out.pairs[key] = await collectPair(page, cfg);
  }

  await browser.close();

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(out, null, 2), 'utf-8');
  console.log('Saved:', OUT_FILE);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
