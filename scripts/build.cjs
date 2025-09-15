import fs from 'node:fs/promises';
import path from 'node:path';
import cheerio from 'cheerio';

const __root = process.cwd();
const DIST = path.join(__root, 'dist');
const MAPPING_FILE = path.join(__root, 'mapping.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 30000;

/** Обёртка fetch с таймаутом */
async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': UA,
        'accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'cache-control': 'no-cache',
        pragma: 'no-cache'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Достаём и сортируем цены (минимальная — первая) */
function extractPrices(html) {
  const $ = cheerio.load(html);

  // Цены лежат в ячейках с классом .tc-price внутри строк .tc-item
  const prices = [];
  $('.tc-item .tc-price').each((_, el) => {
    const raw = $(el).text().trim();
    // Оставляем только цифры, точку/запятую, убираем пробелы и знак рубля
    const numStr = raw.replace(/\s/g, '').replace(/[^\d.,-]/g, '').replace(',', '.');
    const value = parseFloat(numStr);
    if (!Number.isNaN(value) && value > 0) prices.push(value);
  });

  // На всякий: иногда список может быть не отсортирован
  prices.sort((a, b) => a - b);
  return prices;
}

/** Парсим одну страницу FunPay */
async function scrapeOne(item) {
  const { key, game, currency, url } = item;

  const pair = {
    game,
    currency,
    price_RUB: 0,
    change_24h: null,
    change_7d: null,
    updated_at: null,
    trades_top5: []
  };

  try {
    const html = await fetchHtml(url);
    const prices = extractPrices(html);

    if (prices.length > 0) {
      pair.price_RUB = prices[0]; // минимальная цена
      pair.updated_at = new Date().toISOString();
    } else {
      pair.error = 'no_prices_found';
    }
  } catch (e) {
    pair.error = String(e.message || e);
  }

  return [key, pair];
}

async function main() {
  const mapping = JSON.parse(await fs.readFile(MAPPING_FILE, 'utf-8'));

  const out = {
    updated_at: new Date().toISOString(),
    source: 'funpay',
    pairs: {}
  };

  // Ограничим параллелизм до 2, чтобы не спровоцировать антибот
  const concurrency = 2;
  for (let i = 0; i < mapping.length; i += concurrency) {
    const chunk = mapping.slice(i, i + concurrency);
    const entries = await Promise.all(chunk.map(scrapeOne));
    for (const [k, v] of entries) out.pairs[k] = v;
  }

  await fs.mkdir(DIST, { recursive: true });

  // rates.json
  await fs.writeFile(
    path.join(DIST, 'rates.json'),
    JSON.stringify(out, null, 2),
    'utf-8'
  );

  // index.html (живой просмотр rates.json)
  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>poeopt-rates</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; margin: 24px; background:#0d0f14; color:#e7e9ee; }
    a { color:#7cc0ff; }
    pre { white-space: pre-wrap; word-break: break-word; line-height:1.35; }
    .muted { opacity:.7; font-size:.9rem; }
  </style>
</head>
<body>
  <h1>poeopt-rates</h1>
  <p class="muted">Данные: <a href="rates.json">rates.json</a></p>
  <pre id="out">Загрузка...</pre>
  <script>
    fetch('rates.json', {cache:'no-cache'}).then(r=>r.json()).then(j=>{
      document.getElementById('out').textContent = JSON.stringify(j, null, 2);
    }).catch(e=>{
      document.getElementById('out').textContent = 'Ошибка чтения rates.json: ' + e;
    });
  </script>
</body>
</html>`;
  await fs.writeFile(path.join(DIST, 'index.html'), html, 'utf-8');
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
});
