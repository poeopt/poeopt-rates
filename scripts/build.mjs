// scripts/build.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import { load as loadHTML } from 'cheerio';
import { chromium, devices } from 'playwright';
import path from 'node:path';

const OUT_DIR = 'dist';
const DEBUG_DIR = 'debug';

const TARGETS = [
  { key: 'le:gold',               game: 'le',   currency: 'gold',            url: 'https://funpay.com/chips/200/' },
  { key: 'tli:flame-elementium',  game: 'tli',  currency: 'flame-elementium', url: 'https://funpay.com/chips/177/' },
  { key: 'poe2:divine-orb',       game: 'poe2', currency: 'divine-orb',       url: 'https://funpay.com/chips/209/' },
  { key: 'poe1:divine-orb',       game: 'poe1', currency: 'divine-orb',       url: 'https://funpay.com/chips/173/' }
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ACCEPT_LANG = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7';

function toNumberRUB(text) {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, '').replace('₽', '').replace(',', '.');
  const num = Number(normalized.replace(/[^\d.]/g, ''));
  return Number.isFinite(num) ? num : null;
}

function looksLikeCF(html) {
  return /cf-browser-verification|Just a moment|enable JavaScript|cloudflare/i.test(html);
}

async function ensureDirs() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(DEBUG_DIR, { recursive: true });
}

async function scrapeViaHTTP(url, debugKey) {
  const r = await fetch(url, {
    headers: {
      'user-agent': UA,
      'accept-language': ACCEPT_LANG,
      'cache-control': 'no-cache'
    },
    redirect: 'follow'
  });
  const html = await r.text();

  if (!r.ok || looksLikeCF(html)) {
    throw new Error(`http_blocked_or_status_${r.status}`);
  }

  const $ = loadHTML(html);

  // 1) первый видимый ряд (нет класса hidden) → .tc-price .tc-amount
  let node =
    $('a.tc-item:not(.hidden) .tc-price .tc-amount').first() ||
    $('a.tc-item:not(.hidden) .tc-price').first();

  let text = node.text().trim();

  // 2) запасные варианты (иногда в td)
  if (!text) {
    text =
      $('td.tc-price .tc-amount').first().text().trim() ||
      $('td.tc-price').first().text().trim();
  }

  const price = toNumberRUB(text);

  if (!price) {
    // сохраним HTML для диагностики
    await writeFile(path.join(DEBUG_DIR, `${debugKey}-http.html`), html, 'utf8');
    throw new Error('http_parse_failed');
  }
  return price;
}

async function scrapeViaPlaywright(url, debugPrefix) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  try {
    const context = await browser.newContext({
      ...devices['Desktop Chrome'],
      userAgent: UA,
      locale: 'ru-RU',
      viewport: { width: 1366, height: 900 },
      timezoneId: 'Europe/Moscow'
    });

    // спрятать webdriver-флаг
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    // Дождаться, когда появятся либо ряды, либо "нет предложений"
    const rows = page.locator('a.tc-item');
    const empty = page.locator('.tc-empty, .tc-empty__body, text=/нет предложений/i');

    const first = await Promise.race([
      rows.first().waitFor({ state: 'attached', timeout: 45000 }).then(() => 'rows'),
      empty.first().waitFor({ state: 'visible', timeout: 45000 }).then(() => 'empty')
    ]).catch(() => 'timeout');

    if (first === 'empty') {
      await page.screenshot({ path: path.join(DEBUG_DIR, `${debugPrefix}-empty.png`) });
      return null;
    }
    if (first === 'timeout') {
      await page.screenshot({ path: path.join(DEBUG_DIR, `${debugPrefix}-timeout.png`) });
      throw new Error('playwright_timeout_rows');
    }

    // Берём первый НЕ скрытый ряд
    const firstVisible = page.locator('a.tc-item:not(.hidden)').first();

    // Ищем цену — сперва .tc-amount, потом весь .tc-price
    const priceLocator = page.locator(
      'a.tc-item:not(.hidden) .tc-price .tc-amount, ' +
      'a.tc-item:not(.hidden) .tc-price, ' +
      'td.tc-price .tc-amount, td.tc-price'
    ).first();

    await priceLocator.waitFor({ state: 'visible', timeout: 45000 }).catch(() => {});
    await firstVisible.scrollIntoViewIfNeeded().catch(() => {});

    const txt = (await priceLocator.textContent())?.trim();
    const price = toNumberRUB(txt);

    if (!price) {
      await page.screenshot({ path: path.join(DEBUG_DIR, `${debugPrefix}-parse-failed.png`) });
      // снимем ещё мини-скрин считает ли страница, что ряд видим
      try { await firstVisible.screenshot({ path: path.join(DEBUG_DIR, `${debugPrefix}-row.png`) }); } catch {}
      throw new Error('playwright_parse_failed');
    }

    return price;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function getPrice(url, debugKey) {
  // быстрый путь
  try {
    const p = await scrapeViaHTTP(url, debugKey);
    return { price: p, method: 'http' };
  } catch (_) {}

  // фолбэк — браузер
  try {
    const p = await scrapeViaPlaywright(url, debugKey);
    return { price: p, method: 'playwright' };
  } catch (e) {
    return { price: null, method: 'playwright', error: String(e.message || e) };
  }
}

async function build() {
  await ensureDirs();

  const result = {
    updated_at: new Date().toISOString(),
    source: 'funpay',
    pairs: {}
  };

  for (const t of TARGETS) {
    const debugKey = t.key.replace(/[:/\\]+/g, '-');
    const { price, method, error } = await getPrice(t.url, debugKey);

    result.pairs[t.key] = {
      game: t.game,
      currency: t.currency,
      price_RUB: price ?? 0,
      change_24h: null,
      change_7d: null,
      updated_at: new Date().toISOString(),
      trades_top5: [],
      ...(error ? { error: `${method}: ${error}` } : { from: method })
    };
  }

  const html = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"/>
<title>poeopt-rates</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
body{background:#0f0f0f;color:#ddd;font-family:ui-monospace,Consolas,monospace;padding:24px}
a{color:#9cdcfe} pre{background:#141414;border:1px solid #222;border-radius:8px;padding:16px;overflow:auto}
</style></head><body>
<h1>poeopt-rates</h1>
<p>Данные: <a href="rates.json">rates.json</a></p>
<pre id="out">Загрузка…</pre>
<script>
fetch('rates.json?ts=' + Date.now()).then(r=>r.json()).then(j=>{
  document.getElementById('out').textContent = JSON.stringify(j, null, 2);
}).catch(e=>{
  document.getElementById('out').textContent = 'Ошибка загрузки: ' + e;
});
</script>
</body></html>`;

  await writeFile(path.join(OUT_DIR, 'index.html'), html, 'utf8');
  await writeFile(path.join(OUT_DIR, 'rates.json'), JSON.stringify(result, null, 2), 'utf8');

  console.log('✔ dist/rates.json обновлён');
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
