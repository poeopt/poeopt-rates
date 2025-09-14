/**
 * build.cjs — сборщик rates.json + скриншоты для отладки
 * Запуск: `npm run build` (его вызывает GitHub Actions)
 *
 * Ожидает файл `mapping.json` в корне репозитория.
 * Формат mapping:
 *   Вариант А (массив):
 *     [
 *       { "key":"poe2:divine-orb", "game":"poe2", "currency":"divine-orb", "funpay_url":"https://funpay.com/chips/209/" },
 *       ...
 *     ]
 *   Вариант Б (объект-словарь, старый формат):
 *     {
 *       "poe2:divine-orb": { "key":"poe2:divine-orb", "game":"poe2", "currency":"divine-orb", "funpay_url":"https://funpay.com/chips/209/" },
 *       ...
 *     }
 *
 * Выход:
 *   - dist/rates.json
 *   - dist/index.html (простой viewer)
 *   - debug/*.png (скриншоты страниц на момент парсинга)
 */

const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'dist');
const DEBUG_DIR = path.join(ROOT, 'debug');
const MAPPING_PATH = path.join(ROOT, 'mapping.json');

const HEADLESS = true; // на Actions всегда true
const NAV_TIMEOUT = 45000;

/** Утилиты */
async function readMapping() {
  const raw = await fs.readFile(MAPPING_PATH, 'utf-8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`mapping.json невалиден JSON: ${e.message}`);
  }

  // Поддержка двух форматов — массив и словарь
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    return Object.values(data);
  }
  throw new Error('mapping.json должен быть массивом объектов или словарём ключ -> объект');
}

function toNumberSafe(txt) {
  if (!txt) return NaN;
  const m = String(txt).replace(/\u00A0/g, ' ').match(/([0-9]+(?:[.,][0-9]+)?)/);
  if (!m) return NaN;
  return parseFloat(m[1].replace(',', '.'));
}

function nowISO() {
  return new Date().toISOString();
}

async function ensureDirs() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(DEBUG_DIR, { recursive: true });
}

/**
 * Ключевая функция парсинга Funpay.
 * Делаем максимально "живучие" селекторы.
 *
 * Возвращает:
 *   { firstPrice: number|0, top5: number[] }
 */
async function scrapeFunpayPage(browser, url, debugKey) {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    locale: 'ru-RU',
    extraHTTPHeaders: {
      'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
    },
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    // Иногда таблица прогружается лениво — подождём чуть-чуть
    await page.waitForTimeout(1500);

    // Ждём таблицу с лотами (класс меняется, но паттерн стабилен)
    const tableSel = 'table.tc-table, table[class*="tc-table"]';
    await page.waitForSelector(tableSel, { timeout: NAV_TIMEOUT });

    // Чтобы попасть точно в видимую секцию, прокрутим немного вниз (на некоторых страницах шапка перекрывает)
    await page.evaluate(() => window.scrollBy(0, 200));
    await page.waitForTimeout(500);

    // Собираем цены из первых видимых строк
    // Пытаемся разными селекторами (на случай правок вёрстки)
    const prices = await page.evaluate(() => {
      const pickText = (el) => (el ? (el.textContent || '').trim() : '');
      const rows = Array.from(
        document.querySelectorAll('table.tc-table tbody tr:not(.hidden), table[class*="tc-table"] tbody tr:not(.hidden)')
      ).slice(0, 12); // берём с запасом — вдруг попадаются пустые/баннеры

      const out = [];
      for (const tr of rows) {
        // варианты, где может лежать цена:
        // 1) div.tc-price
        // 2) td с атрибутом data-sortable="price"
        // 3) последний столбец, внутри которого число + символ ₽
        let txt =
          pickText(tr.querySelector('div.tc-price')) ||
          pickText(tr.querySelector('td[data-sortable="price"]')) ||
          pickText(tr.querySelector('td:last-child')) ||
          '';

        // иногда внутри есть дочерние с классом "price" — попробуем
        if (!txt || !/[0-9]/.test(txt)) {
          txt = pickText(tr.querySelector('[class*="price"]'));
        }

        if (/[0-9]/.test(txt)) {
          out.push(txt);
        }
      }
      return out;
    });

    const numeric = prices
      .map(toNumberSafe)
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, 5);

    // скриншот в debug
    const shotPath = path.join(DEBUG_DIR, `${debugKey}.png`);
    await page.screenshot({ path: shotPath, fullPage: false });

    await context.close();

    return {
      firstPrice: numeric.length ? numeric[0] : 0,
      top5: numeric,
    };
  } catch (err) {
    // Скрин для неудачных случаев тоже полезен
    try {
      const shotPath = path.join(DEBUG_DIR, `${debugKey}__error.png`);
      await page.screenshot({ path: shotPath, fullPage: false });
    } catch (_) {}
    await context.close();
    return { firstPrice: 0, top5: [] };
  }
}

/** Генерим простой index.html (для проверки руками) */
async function writeIndex() {
  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>poeopt-rates</title>
  <style>
    :root{color-scheme:dark light;}
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;background:#0e0e0f;color:#e9e9ea;padding:24px}
    a{color:#9ad}
    table{border-collapse:collapse;margin-top:16px;width:100%;max-width:860px}
    th,td{border:1px solid #333;padding:8px 10px;text-align:left}
    th{background:#16181c}
    tr:nth-child(odd){background:#0f1115}
    .muted{opacity:.7}
    .chip{display:inline-block;background:#1b2030;border:1px solid #2a3247;border-radius:999px;padding:0 10px;line-height:24px;font-size:12px;margin-right:6px}
  </style>
</head>
<body>
  <h1>poeopt-rates</h1>
  <div><span class="muted">Данные:</span> <a href="./rates.json">rates.json</a></div>
  <div id="when" class="muted" style="margin-top:8px"></div>

  <table id="tbl" style="display:none">
    <thead>
      <tr><th>key</th><th>game</th><th>currency</th><th>price_RUB</th><th>top5</th><th>updated_at</th></tr>
    </thead>
    <tbody></tbody>
  </table>

  <script>
    async function main(){
      try{
        const r = await fetch('./rates.json', {cache:'no-store'});
        const data = await r.json();

        document.getElementById('when').textContent = 'Обновлено: ' + (data.updated_at || '');

        const tbody = document.querySelector('#tbl tbody');
        tbody.innerHTML = '';
        const pairs = data.pairs || {};
        for (const [key, v] of Object.entries(pairs)) {
          const tr = document.createElement('tr');
          const top5 = (v.trades_top5||[]).map(x=>x.price_RUB ?? x).join(', ');
          tr.innerHTML = '<td>'+key+'</td>'+
                         '<td>'+ (v.game||'') +'</td>'+
                         '<td>'+ (v.currency||'') +'</td>'+
                         '<td>'+ (v.price_RUB ?? 0) +'</td>'+
                         '<td>'+ top5 +'</td>'+
                         '<td class="muted">'+ (v.updated_at||'') +'</td>';
          tbody.appendChild(tr);
        }
        document.getElementById('tbl').style.display = '';
      }catch(e){
        document.getElementById('when').textContent = 'Не удалось прочитать rates.json';
      }
    }
    main();
  </script>
</body>
</html>`;
  await fs.writeFile(path.join(OUT_DIR, 'index.html'), html, 'utf-8');
}

/** Основной пайплайн */
(async () => {
  await ensureDirs();

  const mapping = await readMapping();

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const outPairs = {};

  for (const item of mapping) {
    const key = item.key || `${item.game}:${item.currency}`;
    const url = item.funpay_url;
    if (!url) {
      // если в mapping нет ссылки — просто пропускаем
      outPairs[key] = {
        game: item.game || '',
        currency: item.currency || '',
        price_RUB: 0,
        change_24h: null,
        change_7d: null,
        updated_at: nowISO(),
        trades_top5: [],
      };
      continue;
    }

    const { firstPrice, top5 } = await scrapeFunpayPage(browser, url, key);

    outPairs[key] = {
      game: item.game || '',
      currency: item.currency || '',
      price_RUB: firstPrice || 0,
      change_24h: null,
      change_7d: null,
      updated_at: nowISO(),
      trades_top5: top5.map((p) => ({ price_RUB: p })),
    };
  }

  await browser.close();

  const payload = {
    updated_at: nowISO(),
    source: 'funpay',
    pairs: outPairs,
  };

  await fs.writeFile(path.join(OUT_DIR, 'rates.json'), JSON.stringify(payload, null, 2), 'utf-8');
  await writeIndex();

  console.log('✓ Готово: dist/rates.json и dist/index.html');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
