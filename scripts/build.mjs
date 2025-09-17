// scripts/build.mjs
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// === пути вывода ===
const OUT_DIR     = path.resolve(__dirname, '../public');
const OUT_FILE    = path.join(OUT_DIR, 'rates.json');
const DEBUG_DIR   = path.resolve(__dirname, '../debug');
// ВАЖНО: build.mjs лежит в scripts/, поэтому до корня — ../
const MAPPING_PATH = path.resolve(__dirname, '../mapping.json');

// === тайминги ===
const NAV_TIMEOUT  = 35_000;
const WAIT_VISIBLE = 12_000;
const MAX_RETRIES  = 2;

// === утилиты ===
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();
const sanitize = (name) =>
  String(name)
    .replace(/[^\w\d.-]+/g, '_')   // всё «лишнее» -> "_"
    .replace(/_+/g, '_')           // сжать повторяющиеся "_"
    .slice(0, 80);                 // защита от слишком длинных

async function saveDebug(page, key, stage, withHtml = false) {
  try {
    await mkdir(DEBUG_DIR, { recursive: true });
    const safe = sanitize(key);
    await page.screenshot({
      path: path.join(DEBUG_DIR, `${safe}-${stage}.png`),
      fullPage: true
    });
    if (withHtml) {
      const html = await page.content();
      await writeFile(path.join(DEBUG_DIR, `${safe}-${stage}.html`), html, 'utf-8');
    }
  } catch { /* ignore */ }
}

async function closeCookieBanner(page){
  try {
    const btn = page.locator('[data-gtm="cookie-agree"], button:has-text("Согласен"), button:has-text("Принять")');
    await btn.first().click({ timeout: 1500 });
  } catch {}
}

async function ensureVisiblePrices(page){
  const tiles = page.locator('.tc-item .tc-price, .tc-item [class*="tc-price"]');
  const table = page.locator('table.tc-table .tc-price, table.tc-table [class*="tc-price"]');
  try {
    await Promise.any([
      tiles.first().waitFor({ state: 'visible', timeout: WAIT_VISIBLE }),
      table.first().waitFor({ state: 'visible', timeout: WAIT_VISIBLE })
    ]);
  } catch {
    await page.mouse.wheel(0, 1200);
    await sleep(600);
    await Promise.any([
      tiles.first().waitFor({ state: 'visible', timeout: 4000 }).catch(()=>{}),
      table.first().waitFor({ state: 'visible', timeout: 4000 }).catch(()=>{})
    ]);
  }
}

async function pickLeagueIfNeeded(page, leagueText){
  if (!leagueText) return;
  try {
    const ddHeader = page
      .locator('.tc-dropdown__header, .tc-select__header, .tc-dropdown, .ui-select')
      .filter({ hasNotText: /Только продавцы/i })
      .first();
    await ddHeader.click({ timeout: 2000 });
    const option = page
      .locator('.tc-dropdown__item, .tc-dropdown__list li, .ui-select__item, [role="option"]')
      .filter({ hasText: leagueText })
      .first();
    await option.click({ timeout: 3000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(()=>{});
  } catch {}
}

async function extractTopPrices(page, avgTop = 5){
  const prices = await page.locator('.tc-price').evaluateAll(nodes => {
    const nums = [];
    for (const el of nodes){
      const ds = el.getAttribute('data-s');
      if (ds && /^[\d.,]+$/.test(ds)) {
        const n = Number(ds.replace(',', '.'));
        if (!Number.isNaN(n)) nums.push(n);
        continue;
      }
      const txt = (el.textContent || '').replace(/\s+/g,'').replace(/[₽рР]+/g,'').replace(',', '.');
      const m = txt.match(/-?\d+(?:\.\d+)?/);
      if (m) {
        const n = Number(m[0]);
        if (!Number.isNaN(n)) nums.push(n);
      }
    }
    return nums;
  });

  const uniq = [...new Set(prices.filter(n => Number.isFinite(n) && n >= 0))].sort((a,b) => a - b);
  const tops = uniq.slice(0, Math.max(1, avgTop));
  const price = tops.length ? (tops.length >= 3 ? (tops[0] + tops[1] + tops[2]) / 3 : tops[0]) : 0;
  return { price, tops };
}

async function collectPair(page, cfg){
  const out = {
    game: cfg.game,
    currency: cfg.currency,
    price_RUB: 0,
    change_24h: null,
    change_7d: null,
    updated_at: null,
    trades_tops: [],
    error: null
  };

  const url = cfg.funpay_url;
  const league = cfg.league || null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++){
    try{
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(()=>{});
      await closeCookieBanner(page);
      await saveDebug(page, cfg.key, `before-${attempt}`);

      await pickLeagueIfNeeded(page, league);
      await ensureVisiblePrices(page);
      await saveDebug(page, cfg.key, `visible-${attempt}`);

      const { price, tops } = await extractTopPrices(page, cfg.avg_top ?? 5);
      if (tops.length === 0) throw new Error('Нет видимых цен');

      out.price_RUB   = Number(price.toFixed(2));
      out.trades_tops = tops;
      out.updated_at  = nowISO();
      out.error = null;

      await saveDebug(page, cfg.key, 'ok');
      break;
    } catch(err){
      out.error = String(err?.message || err);
      if (attempt < MAX_RETRIES){
        await sleep(800);
        continue;
      }
      // финальная попытка — сохраняем развёрнутый дебаг
      await saveDebug(page, cfg.key, 'error', true);
    }
  }

  return out;
}

async function main(){
  // всегда создаём debug и кладём маркер запуска,
  // чтобы шаг Upload artifacts нашёл хотя бы 1 файл
  await mkdir(DEBUG_DIR, { recursive: true });
  await writeFile(path.join(DEBUG_DIR, '_run.txt'), `Run at ${nowISO()}\n`, 'utf-8');

  // читаем карту
  const mapping = JSON.parse(await readFile(MAPPING_PATH, 'utf-8'));

  // браузер
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    locale: 'ru-RU',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();

  // сборка
  const output = { updated_at: nowISO(), source: 'funpay', pairs: {} };
  for (const cfg of mapping){
    output.pairs[cfg.key] = await collectPair(page, cfg);
  }

  await browser.close();

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
  console.log('Saved:', OUT_FILE);
}

main().catch(err => { console.error(err); process.exit(1); });
