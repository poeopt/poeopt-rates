// scripts/build.mjs
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- настройка ----------
const OUT_DIR = path.resolve(__dirname, '../public');
const OUT_FILE = path.join(OUT_DIR, 'rates.json');

const NAV_TIMEOUT_MS = 60_000;     // навигация/загрузка страницы
const PRICE_WAIT_MS = 25_000;      // ожидание появления цены
const GLOBAL_TIMEOUT_MS = 90_000;  // на один парс одного урла

// читаем mapping.json из КОРНЯ репозитория
const MAPPING_PATH = path.resolve(__dirname, '../mapping.json');
// --------------------------------

/** Нормализуем текст цены в число RUB */
function parseRubToNumber(txt) {
  if (!txt) return null;
  // вычищаем неразрывные пробелы и прочий мусор
  const cleaned = txt.replace(/\u00A0/g, ' ').replace(/[^\d.,\s]/g, '');
  // берём первую "числовую группу"
  const m = cleaned.match(/(\d[\d\s.,]*)/);
  if (!m) return null;
  // убираем пробелы-разделители тысяч, запятую меняем на точку
  const numStr = m[1].replace(/\s/g, '').replace(',', '.');
  const n = Number(numStr);
  return Number.isFinite(n) ? n : null;
}

/** Берём текст цены из разных селекторов */
async function pickPriceText(page) {
  // 1) ждём любой видимый блок цены
  const candidates = [
    '.tc-item .tc-price',
    'a.tc-item .tc-price',
    '.tc-price',
    'span[class*="price"]',
  ];
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel);
      await loc.first().waitFor({ state: 'visible', timeout: PRICE_WAIT_MS });
      const txt = await loc.first().textContent().catch(() => null);
      if (txt && parseRubToNumber(txt) !== null) return txt;
    } catch { /* fallthrough */ }
  }

  // 2) если не дождались — пробуем собрать тексты у первых N строк
  const texts = await page.$$eval('a.tc-item, .tc-item', rows =>
    rows.slice(0, 30).map(r => {
      const el =
        r.querySelector('.tc-price') ||
        r.querySelector('span[class*="price"]') ||
        r;
      return el?.textContent || '';
    }),
  ).catch(() => []);

  let best = null;
  for (const t of texts) {
    const n = parseRubToNumber(t);
    if (n !== null) {
      if (best === null || n < best) best = n;
    }
  }
  return best !== null ? String(best) : null;
}

/** Открываем url и достаём минимальную цену */
async function scrapeFunpayPrice(page, url) {
  const urlWithBypassCache = url.includes('?') ? `${url}&_=${Date.now()}` : `${url}?_=${Date.now()}`;

  await page.goto(urlWithBypassCache, {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT_MS,
  });

  // даём странице время дорендерить таблицу
  await page.waitForTimeout(1200);

  // лёгкий скролл, чтобы триггернуть ленивые списки (если есть)
  try {
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(400);
  } catch {}

  // пробуем взять цену (см. pickPriceText)
  const txt = await pickPriceText(page);

  // если не получилось — последняя попытка: берём HTML и парсим по паттерну "<число> ₽"
  if (!txt) {
    const html = await page.content().catch(() => '');
    const m = html.match(/(\d[\d\s.,]*)\s*₽/);
    if (m) return parseRubToNumber(m[1]);
    return null;
  }

  return parseRubToNumber(txt);
}

async function main() {
  const pairs = JSON.parse(await readFile(MAPPING_PATH, 'utf8'));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'ru-RU',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    timezoneId: 'Europe/Berlin',
  });
  const page = await context.newPage();

  const result = {
    updated_at: new Date().toISOString(),
    source: 'funpay',
    pairs: {},
  };

  for (const item of pairs) {
    const key = item.key; // например "poe2:divine-orb"
    const entry = {
      game: item.game,
      currency: item.currency,
      price_RUB: 0,
      change_24h: null,
      change_7d: null,
      updated_at: null,
      trades_top5: [],
    };

    try {
      const ctrl = Promise.race([
        (async () => {
          const price = await scrapeFunpayPrice(page, item.funpay_url);
          entry.price_RUB = price ?? 0;
          entry.updated_at = new Date().toISOString();
        })(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('timeout')), GLOBAL_TIMEOUT_MS),
        ),
      ]);
      await ctrl;

      if (!entry.price_RUB) {
        // сохраним диагностическое поле, но без падения сборки
        entry.error = 'price_not_found';
      }
    } catch (e) {
      entry.updated_at = new Date().toISOString();
      entry.price_RUB = 0;
      entry.trades_top5 = [];
      entry.error = String(e && e.message ? e.message : e);
    }

    result.pairs[key] = entry;
  }

  await browser.close();

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(result, null, 2), 'utf8');

  // опционально: добавим простую страницу-предпросмотр в корень, если у тебя её нет
  const indexPath = path.join(OUT_DIR, 'index.html');
  const indexHtml = `<!doctype html>
<html lang="ru">
<meta charset="utf-8">
<title>poeopt-rates</title>
<style>
  body { background:#0b0b0b; color:#ddd; font:14px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; padding:26px; }
  a { color:#6aa7ff; }
  pre { background:#111; border:1px solid #222; border-radius:10px; padding:16px; overflow:auto; }
</style>
<h1>poeopt-rates</h1>
<p>Данные: <a href="rates.json">rates.json</a></p>
<pre id="out">Загрузка…</pre>
<script type="module">
  const res = await fetch('./rates.json?ts=' + Date.now());
  const json = await res.json();
  document.getElementById('out').textContent = JSON.stringify(json, null, 2);
</script>
</html>`;
  try {
    // не перезаписываем, если уже есть свой index.html
    await writeFile(indexPath, indexHtml, { flag: 'wx' });
  } catch { /* уже существует — ок */ }

  console.log('OK: written', OUT_FILE);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
