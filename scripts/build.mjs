// scripts/build.mjs
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();
const MAP_PATH = path.resolve(ROOT, "mapping.json");
const OUT_DIR = path.resolve(ROOT, "public");
const OUT_FILE = path.resolve(OUT_DIR, "rates.json");
const DEBUG_DIR = path.resolve(ROOT, "debug");

// ────────────────────────────────────────────────────────────────────────────────
// helpers

const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ensureDir = async (p) => { try { await fs.mkdir(p, { recursive: true }); } catch {} };
const sanitize = (name) =>
  String(name).toLowerCase().replace(/[^a-z0-9._-]+/gi, "_");

// выбрать опцию в <select> по видимому тексту (точное совпадение или подстрока)
async function selectByLabel(page, selectors, label) {
  if (!label) return false;

  for (const sel of selectors) {
    const exists = await page.$(sel);
    if (!exists) continue;

    // 1) пробуем как есть — по label
    try {
      await page.selectOption(sel, { label });
      return true;
    } catch {}

    // 2) находим опцию, где текст совпадает или содержит искомую строку
    const val = await page.evaluate(({ sel, label }) => {
      const el = /** @type {HTMLSelectElement|null} */(document.querySelector(sel));
      if (!el) return null;
      const txt = (s) => (s || "").trim().toLowerCase();
      const want = txt(label);
      let opt = Array.from(el.options).find(o => txt(o.textContent) === want);
      if (!opt) opt = Array.from(el.options).find(o => txt(o.textContent).includes(want));
      return opt?.value ?? null;
    }, { sel, label });

    if (val) {
      try {
        await page.selectOption(sel, val);
        return true;
      } catch {}
    }
  }
  return false;
}

// подождать, пока появится любая «табличная» разметка с ценами
async function waitForPriceArea(page, timeout = 20000) {
  // закрываем сразу 3 кейса разметки Funpay: чипы/товары/валюты
  const ANY_LIST = ".tc-price, .tc-table .tc-item, table.tc-table";
  await page.waitForSelector(ANY_LIST, { state: "visible", timeout });
}

// собрать TOP-5 цен сверху списка
async function parseTopPrices(page, max = 5) {
  // небольшой «толчок», чтобы ленивые слои точно дорисовали числа
  await sleep(300);
  await page.evaluate(() => { window.scrollBy(0, 1); window.scrollBy(0, -1); });

  // берём любые явные блоки цен
  const PRICES_SELECTOR = ".tc-price, td.tc-price, div.tc-price";

  const tops = await page.$$eval(PRICES_SELECTOR, (nodes, max) => {
    const take = [];
    const toNum = (s) => {
      if (!s) return null;
      const m = s.replace(/[^\d.,]/g, "").replace(",", ".");
      const v = parseFloat(m);
      return Number.isFinite(v) ? v : null;
    };

    for (const n of nodes) {
      const t = (n.textContent || "").trim();
      const v = toNum(t);
      if (v !== null) {
        take.push(v);
        if (take.length === max) break;
      }
    }
    return take;
  }, max);

  return tops;
}

// ────────────────────────────────────────────────────────────────────────────────
// основной парсер одной пары

async function scrapePair(browser, pair) {
  const { key, game, currency, funpay_url, league } = pair;

  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
  });

  const safeKey = sanitize(key);

  const out = {
    [key]: {
      game,
      currency,
      price_RUB: 0,
      change_24h: null,
      change_7d: null,
      updated_at: null,
      trades_tops: [],
      error: null
    }
  };

  try {
    // грузим страницу
    await page.goto(funpay_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await Promise.race([page.waitForLoadState("networkidle").catch(() => {}), sleep(500)]);

    // пробуем выбрать нужную лигу/сезон
    const picked = await selectByLabel(
      page,
      [
        'select[name="server"]',         // PoE/PoE2 currencies
        'select#server',
        'select.showcase-filter-input[name="server"]',
        'select[name="league"]',         // иногда у товаров
        'select#league'
      ],
      league
    );

    if (picked) {
      // слегка подождём, пока страница перестроится
      await Promise.race([page.waitForLoadState("networkidle").catch(()=>{}), sleep(800)]);
    }

    // ждём появления цен
    await waitForPriceArea(page, 20000);

    // собираем TOP-5
    const tops = await parseTopPrices(page, 5);
    out[key].trades_tops = tops;
    out[key].price_RUB = tops[0] ?? 0;
    out[key].updated_at = nowISO();

    // успешный скрин
    await ensureDir(DEBUG_DIR);
    await page.screenshot({ path: path.join(DEBUG_DIR, `${safeKey}.png`) });
  } catch (err) {
    out[key].error = String(err?.message || err);
    out[key].updated_at = nowISO();
    try {
      await ensureDir(DEBUG_DIR);
      await page.screenshot({ path: path.join(DEBUG_DIR, `${safeKey}_error.png`), fullPage: true });
    } catch {}
  } finally {
    await page.close();
  }

  return out;
}

// ────────────────────────────────────────────────────────────────────────────────
// main

async function main() {
  await ensureDir(OUT_DIR);
  await ensureDir(DEBUG_DIR);

  const mapping = JSON.parse(await fs.readFile(MAP_PATH, "utf8"));
  const browser = await chromium.launch({ headless: true });

  const merged = {};
  for (const pair of mapping) {
    const part = await scrapePair(browser, pair);
    Object.assign(merged, part);
  }

  await browser.close();

  const payload = {
    updated_at: nowISO(),
    source: "funpay",
    pairs: merged
  };

  await fs.writeFile(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(`✔ saved ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
