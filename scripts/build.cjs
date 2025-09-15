// scripts/build.mjs
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const MAP_PATH = path.join(ROOT, 'mapping.json');
const TIMEOUT_MS = 60000; // таймаут ожиданий на странице
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';

function asNumRub(text) {
  // вытаскиваем число из строки вида "23.07 ₽" / "23,07 ₽"
  const raw = String(text).replace(/[^\d.,]/g, '').replace(',', '.');
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

async function readMapping() {
  const raw = await fs.readFile(MAP_PATH, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error('mapping.json должен быть МАССИВОМ объектов');
  data.forEach((x, i) => {
    ['key', 'game', 'currency', 'url'].forEach((k) => {
      if (!x[k]) throw new Error(`mapping[${i}].${k} отсутствует`);
    });
  });
  return data;
}

async function ensureDist() {
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });
}

async function buildViewer() {
  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>poeopt-rates</title>
<style>
  :root{color-scheme:dark light}
  body{margin:0;font:14px/1.4 system-ui,Segoe UI,Roboto,Arial,sans-serif;background:#0f0f0f;color:#eee}
  .wrap{max-width:960px;margin:32px auto;padding:0 16px}
  h1{margin:0 0 12px 0}
  a{color:#7ec8ff;text-decoration:none}
  pre{background:#111;border:1px solid #222;border-radius:8px;padding:16px;overflow:auto}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .meta{opacity:.8;margin:8px 0 16px}
</style>
</head>
<body>
  <div class="wrap">
    <h1>poeopt-rates</h1>
    <div class="meta">Данные: <a href="rates.json">rates.json</a></div>
    <pre id="out"><code>Загрузка...</code></pre>
  </div>
<script>
  fetch('rates.json', {cache:'no-store'}).then(r=>r.json()).then(data=>{
    out.textContent = JSON.stringify(data, null, 2);
  }).catch(err=>{
    out.textContent = 'Ошибка загрузки rates.json: '+ err;
  });
</script>
</body>
</html>`;
  await fs.writeFile(path.join(DIST, 'index.html'), html, 'utf8');
}

async function scrapePrice(page) {
  // набор селекторов, которые встречаются на FunPay в ячейке "Цена"
  const selectors = [
    '.tc-price', 'td.tc-price', 'div.tc-price', 'span.tc-price',
    '.c-price'
  ];
  // ждём, пока таблица/цены появятся
  await page.waitForFunction(() => {
    const sels = ['.tc-price','td.tc-price','div.tc-price','span.tc-price','.c-price','[data-price]'];
    return sels.some(sel => document.querySelector(sel));
  }, { timeout: TIMEOUT_MS });

  // 1) пробуем явные ячейки с ценой
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      const txt = (await loc.innerText()).trim();
      const n = asNumRub(txt);
      if (n > 0) return n;
    }
  }
  // 2) некоторые узлы держат цену в data-атрибутах
  const dataPrice = await page.evaluate(() => {
    const el = document.querySelector('[data-price]');
    return el ? (el.getAttribute('data-price') || '') : '';
  });
  if (dataPrice) {
    const n = asNumRub(dataPrice);
    if (n > 0) return n;
  }
  // 3) крайний случай — ищем в plain-тексте "N ₽"
  const bodyText = await page.evaluate(() => document.body.innerText);
  const m = bodyText.match(/(\d+[.,]\d{1,2})\s*₽/);
  if (m) {
    const n = asNumRub(m[1]);
    if (n > 0) return n;
  }
  throw new Error('PRICE_NOT_FOUND');
}

async function scrapeOne(context, entry) {
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);

  // отключаем тяжёлые ресурсы
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (/\.(png|jpe?g|gif|webp|svg|mp4|avi|mov|webm|woff2?|ttf|otf)$/i.test(url)) {
      return route.abort();
    }
    return route.continue();
  });

  const res = {
    game: entry.game,
    currency: entry.currency,
    price_RUB: 0,
    change_24h: null,
    change_7d: null,
    trades_top5: [],
    updated_at: new Date().toISOString()
  };

  try {
    await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });

    // пробуем включить "Только продавцы онлайн" — если есть такой переключатель
    const online = page.locator('text=Только продавцы онлайн');
    if (await online.count()) {
      await online.first().click().catch(()=>{});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
    }

    const price = await scrapePrice(page);
    res.price_RUB = price;
  } catch (e) {
    // записываем причину, но сборку не валим
    res.error = String(e && e.message ? e.message : e);
  } finally {
    await page.close();
  }
  return res;
}

async function main() {
  const mapping = await readMapping();
  await ensureDist();

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'ru-RU',
    timezoneId: 'Europe/Berlin', // у пользователя — Франкфурт; можно оставить так
    viewport: { width: 1280, height: 900 }
  });
  // маленький "stealth": webdriver = undefined
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const pairs = {};
  for (const entry of mapping) {
    const item = await scrapeOne(context, entry);
    pairs[entry.key] = item;
    // небольшой «бэк-офф», чтобы не долбить FunPay слишком быстро
    await new Promise(r => setTimeout(r, 1000));
  }

  await browser.close();

  const output = {
    updated_at: new Date().toISOString(),
    source: 'funpay',
    pairs
  };

  await fs.writeFile(path.join(DIST, 'rates.json'), JSON.stringify(output, null, 2), 'utf8');
  await buildViewer();

  console.log('OK: dist/rates.json создан, size=', (await fs.stat(path.join(DIST, 'rates.json'))).size);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
