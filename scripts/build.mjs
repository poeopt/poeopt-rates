// build.mjs (repo root)
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OUT_DIR   = path.resolve(__dirname, 'public');
const OUT_FILE  = path.join(OUT_DIR, 'rates.json');
const DEBUG_DIR = path.resolve(__dirname, 'debug');
const MAPPING_PATH = path.resolve(__dirname, 'mapping.json');

const NAV_TIMEOUT   = 35_000;  // полная загрузка
const WAIT_VISIBLE  = 12_000;  // ожидание видимости цен
const MAX_RETRIES   = 2;

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function sanitize(name){
  return String(name).replace(/[^\w\d.-]+/g, '_').replace(/_+/g,'_').slice(0,80);
}
function parseRUB(txt){
  if (!txt) return null;
  const s = String(txt).replace(/\s+/g,'').replace(/[₽рР]+/g,'').replace(',', '.');
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

async function closeCookieBanner(page){
  try {
    const btn = page.locator('[data-gtm="cookie-agree"], button:has-text("Согласен"), button:has-text("Принять")');
    await btn.first().click({ timeout: 1500 });
  } catch {}
}

async function ensureVisiblePrices(page){
  // ждём либо таблицу, либо плитки
  const tiles = page.locator('.tc-item .tc-price, .tc-item [class*="tc-price"]');
  const table = page.locator('table.tc-table .tc-price, table.tc-table [class*="tc-price"]');
  try {
    await Promise.any([
      tiles.first().waitFor({ state: 'visible', timeout: WAIT_VISIBLE }),
      table.first().waitFor({ state: 'visible', timeout: WAIT_VISIBLE })
    ]);
  } catch {
    await page.mouse.wheel(0, 1200); // триггерим lazy-load
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
  // собираем числа из любых .tc-price (и по data-s, и по тексту)
  const prices = await page.locator('.tc-price').evaluateAll(nodes => {
    const nums = [];
    for (const el of nodes){
      const ds = el.getAttribute('data-s');
      if (ds && /^[\d.,]+$/.test(ds)){
        const n = Number(ds.replace(',', '.'));
        if (!Number.isNaN(n)) nums.push(n);
        continue;
      }
      const txt = el.textContent || '';
      const cleaned = txt.replace(/\s+/g,'').replace(/[₽рР]+/g,'').replace(',', '.');
      const m = cleaned.match(/-?\d+(\.\d+)?/);
      if (m){
        const n = Number(m[0]);
        if (!Number.isNaN(n)) nums.push(n);
      }
    }
    return nums;
  });

  const uniq = [...new Set(prices.filter(n => typeof n === 'number' && isFinite(n) && n >= 0))];
  uniq.sort((a,b) => a - b);
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
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(()=>{});
      await closeCookieBanner(page);
      await pickLeagueIfNeeded(page, league);
      await ensureVisiblePrices(page);

      const { price, tops } = await extractTopPrices(page, cfg.avg_top ?? 5);

      if (tops.length === 0){
        throw new Error('Нет видимых цен');
      }

      out.price_RUB   = Number(price.toFixed(2));
      out.trades_tops = tops;
      out.updated_at  = new Date().toISOString();
      out.error = null;
      break;
    } catch(err){
      out.error = String(err.message || err);
      if (attempt < MAX_RETRIES){
        await sleep(800);
        continue;
      }
      try{
        await mkdir(DEBUG_DIR, { recursive: true });
        await page.screenshot({ path: path.join(DEBUG_DIR, `${sanitize(cfg.key)}.png`), fullPage: true });
      } catch {}
    }
  }

  return out;
}

async function main(){
  const mapping = JSON.parse(await readFile(MAPPING_PATH, 'utf-8'));

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

  const output = {
    updated_at: new Date().toISOString(),
    source: 'funpay',
    pairs: {}
  };

  for (const cfg of mapping){
    output.pairs[cfg.key] = await collectPair(page, cfg);
  }

  await browser.close();

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
  console.log('Saved:', OUT_FILE);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
