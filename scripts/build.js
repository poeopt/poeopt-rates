// scripts/build.js
// Сборщик лайв-курсов с FunPay через Playwright.
// Делает VWAP/среднюю по топ-5 ценам, пишет dist/rates.json и сохраняет отладочные артефакты.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const MAP = require('../mapping.json');

const OUT_DIR = path.join(process.cwd(), 'dist');
const DEBUG_DIR = path.join(process.cwd(), 'debug');

// полезно, чтобы артефакты попали в GitHub Actions Artifacts
for (const dir of [OUT_DIR, DEBUG_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------- УТИЛИТЫ ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sanitize = (s) => s.replace(/[\\/:*?"<>|]/g, '_'); // для имён файлов

function mean(nums) {
  const arr = nums.filter(v => typeof v === 'number' && !Number.isNaN(v));
  if (!arr.length) return null;
  return arr.reduce((a,b)=>a+b,0) / arr.length;
}

function median(nums) {
  const arr = nums.filter(v => typeof v === 'number' && !Number.isNaN(v)).sort((a,b)=>a-b);
  if (!arr.length) return null;
  const m = Math.floor(arr.length/2);
  return arr.length % 2 ? arr[m] : (arr[m-1]+arr[m])/2;
}

// ---------- ОСНОВНОЙ ПАРСЕР ОДНОЙ СТРАНИЦЫ ----------
async function scrapeFunpayPage(page, url, keyForDebug) {
  const debugBase = sanitize(keyForDebug);

  // экономим трафик: картинки/шрифты не нужны
  await page.route('**/*', (route) => {
    const rt = route.request().resourceType();
    if (rt === 'image' || rt === 'font' || rt === 'media') return route.abort();
    route.continue();
  });

  // навигация
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (!resp || !resp.ok()) {
    throw new Error(`HTTP ${resp ? resp.status() : 'no response'} for ${url}`);
  }

  // иногда контент подтягивается после интерактивности — подождём чуть-чуть
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{});

  // ❶ Жёстко ждём, пока на странице появятся хотя бы 5 видимых цен вида "xx.xx ₽"
  //   (сканируем любой элемент, у которого в текстовом содержимом встречается ₽)
  await page.waitForFunction(() => {
    const RX = /\d+(?:[.,]\d{1,2})?\s*₽/;
    const nodes = Array.from(document.querySelectorAll('body *'));
    let found = 0;
    for (const el of nodes) {
      const t = (el.innerText || el.textContent || '').trim();
      if (RX.test(t)) found++;
      if (found >= 5) return true;
    }
    return false;
  }, { timeout: 25000 });

  // ❷ Снимаем HTML-снапшот и скрин (на случай сбоя будет видно что парсим)
  const htmlPath = path.join(DEBUG_DIR, `${debugBase}.html`);
  const pngPath  = path.join(DEBUG_DIR, `${debugBase}.png`);
  try {
    await fs.promises.writeFile(htmlPath, await page.content(), 'utf8');
    await page.screenshot({ path: pngPath, fullPage: false });
  } catch (e) {
    // не критично
  }

  // ❸ Выбираем «строки списка» максимально широко.
  //    На FunPay бывает таблица, бывает грид — берём всё похожее на строку.
  const rows = await page.$$eval(
    [
      'table tbody tr',
      '.table tbody tr',
      '.lots-row',
      '[class*="Row"]',
      'div[class*="row"][class*="Lots"]',
      'div[class*="Row"]',
    ].join(','),
    (els) => els.map(el => {
      const text = (el.innerText || el.textContent || '').replace(/\s+/g,' ').trim();
      // отдельные поля попытаемся угадать:
      const priceMatch = text.match(/(\d+(?:[.,]\d{1,2})?)\s*₽/);
      const price = priceMatch ? priceMatch[1].replace(',', '.') : null;
      const amountMatch = text.match(/(?:Наличие|Наличи[ея]|Кол-во|Количество|Нал\.?):?\s*([\d\s]+)/i)
                         || text.match(/\b(\d{1,3}(?:\s\d{3})+)\b/); // «47 000» и т.п.
      const amount = amountMatch ? amountMatch[1].replace(/\s/g,'') : null;

      // продавца часто кладут в ссылку профиля
      let seller = null, href = null;
      const a = el.querySelector('a[href*="/shop/"], a[href*="/user/"]');
      if (a) { seller = (a.innerText || a.textContent || '').trim(); href = a.href || null; }

      return {
        price_RUB: price ? parseFloat(price) : null,
        amount:   amount ? parseInt(amount, 10) : null,
        seller,
        href,
        raw: text,
      };
    })
  );

  // ❹ Фильтруем и берём «первые 5 осмысленных цен»
  const trades = rows
    .filter(r => typeof r.price_RUB === 'number' && !Number.isNaN(r.price_RUB))
    .slice(0, 5);

  // Если почему-то не нашли «строк», fallback: собрать просто первые 5 цен со всей страницы
  let fallbackUsed = false;
  if (trades.length < 1) {
    fallbackUsed = true;
    const anyPrices = await page.$$eval('body *', (els) => {
      const RX = /(\d+(?:[.,]\d{1,2})?)\s*₽/;
      const out = [];
      for (const el of els) {
        const t = (el.innerText || el.textContent || '').trim();
        const m = t.match(RX);
        if (m) {
          out.push({ price_RUB: parseFloat(m[1].replace(',', '.')), raw: t });
        }
        if (out.length >= 5) break;
      }
      return out;
    });
    trades.push(...anyPrices.slice(0, 5));
  }

  const prices = trades.map(t => t.price_RUB).filter(n => typeof n === 'number' && !Number.isNaN(n));
  const avg = mean(prices);
  const med = median(prices);

  return {
    price_RUB: avg ?? null,
    price_med: med ?? null,
    trades_top5: trades,
    updated_at: new Date().toISOString(),
    fallbackUsed,
  };
}

// ---------- ГЛАВНАЯ ФУНКЦИЯ ----------
async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36',
    viewport: { width: 1366, height: 800 },
  });

  const page = await context.newPage();

  const pairs = {};
  for (const p of MAP.pairs) {
    const key = p.key; // например "poe1:divine-orb"
    const url = p.funpay_url;
    const nameForDebug = `${key}__${url.split('/').slice(-2).join('_')}`;

    let result;
    try {
      result = await scrapeFunpayPage(page, url, nameForDebug);
    } catch (e) {
      // если совсем ошибка — записываем заглушку, но с временем
      result = {
        price_RUB: null,
        price_med: null,
        trades_top5: [],
        updated_at: new Date().toISOString(),
        error: String(e && e.message || e),
      };
    }

    pairs[key] = {
      game: p.game,
      currency: p.currency,
      price_RUB: result.price_RUB ?? 0,  // если null, пусть будет 0 (виджет покажет "—")
      change_24h: null,
      change_7d: null,
      updated_at: result.updated_at,
      trades_top5: result.trades_top5 || [],
      _debug: {
        fallbackUsed: !!result.fallbackUsed,
        error: result.error || null,
      },
    };
    // бережная пауза — лишний раз не дёргать антибот
    await sleep(1000);
  }

  const out = {
    updated_at: new Date().toISOString(),
    source: "funpay",
    pairs,
  };

  await fs.promises.writeFile(path.join(OUT_DIR, 'rates.json'), JSON.stringify(out, null, 2), 'utf8');

  // очень простой viewer, чтобы корень gh-pages не 404-ил
  const indexHtml = `<!doctype html>
<html lang="ru"><meta charset="utf-8"/><title>poeopt-rates</title>
<style>body{background:#0e0e0e;color:#ddd;font:14px/1.4 system-ui,Segoe UI,Roboto,Arial}a{color:#f5c15c}</style>
<h2>poeopt-rates</h2>
<p>Данные: <a href="rates.json">rates.json</a></p>
<pre id="p" style="white-space:pre-wrap"></pre>
<script>
fetch('rates.json').then(r=>r.json()).then(j=>{
  document.getElementById('p').textContent = JSON.stringify(j,null,2);
});
</script>
</html>`;
  await fs.promises.writeFile(path.join(OUT_DIR, 'index.html'), indexHtml, 'utf8');

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
