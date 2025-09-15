import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');
const MAPPING_PATH = path.join(ROOT, 'mapping.json');

function nowIso() {
  return new Date().toISOString();
}

function sanitizeKey(key) {
  // Без двоеточий и прочих «левых» символов — пригодится для файлов логов
  return key.replace(/[^a-z0-9-_]+/gi, '_');
}

function parseRubToNumber(text) {
  if (!text) return null;
  // Берём первую «разумную» цену вида "2.19 ₽" | "2,19 ₽" | "2.19Р"
  const m = String(text).replace(/\s+/g, ' ').match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  return Number(m[1].replace(',', '.'));
}

async function ensureOut() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}

async function readMapping() {
  const raw = await fs.readFile(MAPPING_PATH, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error('mapping.json должен быть массивом объектов');
  }
  return data;
}

/**
 * Быстрая попытка: скачать HTML и выдрать цену без браузера.
 * На Funpay часто разметка уже отрендерена на сервере.
 */
function extractPriceFromHtml(html) {
  const $ = cheerio.load(html);

  // Кандидаты ячеек с ценой (разные версии верстки)
  const candidates = [
    '.tc-table .tc-price',           // новая таблица
    'td.tc-price',                   // альтернативная разметка
    '.offer .price, .c-offer .price' // страховка
  ];

  for (const sel of candidates) {
    const nodes = $(sel).toArray();
    for (const el of nodes) {
      const txt = $(el).text().trim();
      const n = parseRubToNumber(txt);
      if (n) return n;
    }
  }

  // Иногда цена прячется в атрибуте title/aria-label
  const attrCandidates = [
    '[title*="₽"]',
    '[aria-label*="₽"]'
  ];
  for (const sel of attrCandidates) {
    const nodes = $(sel).toArray();
    for (const el of nodes) {
      const txt = ($(el).attr('title') || $(el).attr('aria-label') || '').trim();
      const n = parseRubToNumber(txt);
      if (n) return n;
    }
  }

  return null;
}

/**
 * Медленная, но надёжная попытка через Playwright:
 * — идём на страницу
 * — ждём таблицу
 * — скроллим чуть вниз (иногда первый ряд лениво подгружается)
 * — берём цену из первой строки
 */
async function extractPriceWithBrowser(url, { timeoutMs = 45000 } = {}) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      locale: 'ru-RU',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1360, height: 900 }
    });
    const page = await context.newPage();

    await page.route('**/*', route => {
      const req = route.request();
      const type = req.resourceType();
      // режем тяжелые ресурсы
      if (['image', 'font', 'media'].includes(type)) return route.abort();
      return route.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // Ждем появления любой строки в таблице
    const rowSel = '.tc-table tbody tr, .tc-table .tc-row, table tbody tr';
    await page.waitForSelector(rowSel, { timeout: timeoutMs });

    // лёгкий скролл — триггер ленивой подгрузки
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(500);

    const priceText = await page.evaluate(() => {
      const pick = (root) => {
        const priceCell =
          root.querySelector('.tc-price') ||
          root.querySelector('td.tc-price') ||
          root.querySelector('.price');
        if (!priceCell) return null;
        const txt =
          priceCell.getAttribute('title') ||
          priceCell.getAttribute('aria-label') ||
          priceCell.textContent ||
          '';
        return txt.trim();
      };

      const rows = Array.from(document.querySelectorAll('.tc-table tbody tr, .tc-table .tc-row, table tbody tr'));
      for (const r of rows) {
        // пропускаем «плейсхолдеры»
        const hidden = r.classList.contains('hidden') || r.classList.contains('lazyload-hidden');
        const txt = pick(r);
        if (txt && !hidden) return txt;
      }
      // запасной вариант — ищем просто первый ценник на странице
      const any = document.querySelector('.tc-price, td.tc-price, .price');
      return any ? (any.getAttribute('title') || any.getAttribute('aria-label') || any.textContent || '').trim() : '';
    });

    return parseRubToNumber(priceText);
  } finally {
    await browser.close();
  }
}

/**
 * Общий сборщик по одному URL.
 * 1) fetch html → попытка через Cheerio
 * 2) если не получилось → Playwright
 */
async function extractBestPrice(url) {
  // Ставим явные заголовки — меньше шансов на антибот
  const res = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'accept-language': 'ru,en;q=0.9',
      'cache-control': 'no-cache'
    }
  });

  const html = await res.text();
  let price = extractPriceFromHtml(html);
  if (price) return price;

  // Если SSR не дался — включаем браузер.
  price = await extractPriceWithBrowser(url);
  return price;
}

async function main() {
  await ensureOut();
  const mapping = await readMapping();

  const pairs = {};
  const startedAt = nowIso();

  for (const m of mapping) {
    const key = m.key || `${m.game}:${m.currency}`;
    const safe = sanitizeKey(key);
    const entry = {
      game: m.game,
      currency: m.currency,
      price_RUB: 0,
      change_24h: null,
      change_7d: null,
      updated_at: nowIso(),
      trades_top5: []
    };

    try {
      const price = await extractBestPrice(m.url);
      if (price) {
        entry.price_RUB = price;
      } else {
        entry.error = 'price_not_found';
      }
    } catch (e) {
      entry.error = String(e.message || e);
      // При желании сохраним HTML/логи — но без двоеточий и странных символов
      // Никаких артефактов с двоеточиями!
    }

    pairs[key] = entry;
  }

  const payload = {
    updated_at: startedAt,
    source: 'funpay',
    pairs
  };

  await fs.writeFile(path.join(OUT_DIR, 'rates.json'), JSON.stringify(payload, null, 2), 'utf8');

  // Простой viewer-корень
  const indexHtml = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>poeopt-rates</title>
  <style>
    html,body{background:#0e0e0e;color:#e7e7e7;font:16px/1.45 system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:0}
    .wrap{max-width:960px;margin:40px auto;padding:0 16px}
    a{color:#7cc6ff}
    pre{background:#121212;border:1px solid #222;border-radius:8px;padding:16px;overflow:auto}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>poeopt-rates</h1>
    <p>Данные: <a href="rates.json">rates.json</a></p>
    <pre id="out">Загрузка…</pre>
  </div>
  <script>
    fetch('rates.json', {cache: 'no-store'})
      .then(r => r.json())
      .then(j => { document.getElementById('out').textContent = JSON.stringify(j, null, 2); })
      .catch(e => { document.getElementById('out').textContent = 'Ошибка чтения rates.json: ' + e; });
  </script>
</body>
</html>`;
  await fs.writeFile(path.join(OUT_DIR, 'index.html'), indexHtml, 'utf8');

  console.log('OK, rates.json и index.html собраны.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
