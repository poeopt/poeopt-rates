// scripts/build.mjs
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');
const PUBLIC = path.resolve(__dirname, '../public');
const DEBUG = path.resolve(__dirname, '../debug');
const MAP_PATH = path.resolve(__dirname, './mapping.json');

const WAIT = 60_000; // таймаут ожиданий (мс). Если будет мало — подними до 90_000.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const safeName = (s) => s.replace(/[^\w.-]+/g, '-');

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function copyDir(src, dest) {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(from, to);
    else await fs.copyFile(from, to);
  }
}

async function getPrice(context, url, pairId) {
  const page = await context.newPage();
  page.setDefaultTimeout(WAIT);

  // немного “экономим” трафик
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i.test(u)) return route.abort();
    route.continue();
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');

    // ждём, пока где-нибудь появится цена со цифрами
    await page.waitForFunction(() => {
      const spans = Array.from(document.querySelectorAll('span.tc-price'));
      return spans.some((el) => /\d/.test(el.textContent || ''));
    }, { timeout: WAIT });

    // берём самую первую видимую цену
    const text = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('a.tc-item'));
      for (const r of rows) {
        const s = r.querySelector('span.tc-price');
        if (s && /\d/.test(s.textContent || '')) return s.textContent;
      }
      return null;
    });

    const price_RUB = text
      ? Number(String(text).replace(',', '.').replace(/[^\d.]/g, ''))
      : 0;

    return { price_RUB, raw: text ?? null };
  } catch (e) {
    // скрин в debug/ для отладки
    try {
      await ensureDir(DEBUG);
      await page.screenshot({ path: path.join(DEBUG, `${safeName(pairId)}.png`), fullPage: true });
    } catch {}
    return { price_RUB: 0, error: String(e.message || e) };
  } finally {
    await page.close();
  }
}

async function main() {
  const mapping = JSON.parse(await fs.readFile(MAP_PATH, 'utf8'));

  await ensureDir(DIST);
  await ensureDir(DEBUG);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    viewport: { width: 1366, height: 2000 },
  });

  // чуть “человечности”
  context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const pairs = {};
  for (const p of mapping) {
    const id = `${p.game}:${p.currency}`;
    const { price_RUB, raw, error } = await getPrice(context, p.url, id);
    pairs[id] = {
      game: p.game,
      currency: p.currency,
      price_RUB,
      change_24h: null,
      change_7d: null,
      updated_at: new Date().toISOString(),
      trades_top5: [],
      ...(error ? { error } : {}),
      ...(raw ? { debug_text: raw } : {}),
    };
    // маленькая пауза, чтобы не спамить
    await sleep(500);
  }

  await browser.close();

  const out = {
    updated_at: new Date().toISOString(),
    source: 'funpay',
    pairs,
  };

  await fs.writeFile(path.join(DIST, 'rates.json'), JSON.stringify(out, null, 2), 'utf8');

  // корневую страницу берём из /public
  try {
    await copyDir(PUBLIC, DIST);
  } catch {}

  console.log('Done:', Object.keys(pairs));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
