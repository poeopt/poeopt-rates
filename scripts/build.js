// scripts/build.js — парсер FunPay с fallback-логикой и отладочными дампами
import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";
import mapping from "../mapping.json" assert { type: "json" };

const NOW = () => new Date().toISOString();
const TOP_N = 5;
const DEBUG_DIR = "debug";

function toFloat(text) {
  if (!text) return 0;
  const s = String(text)
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, "")
    .replace(",", ".")
    .replace(/[^\d.]/g, "");
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}

function median(v) {
  if (!v.length) return 0;
  const a = [...v].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function vwap(rows) {
  const qty = rows.reduce((s, r) => s + (r.amount || 0), 0);
  const tot = rows.reduce((s, r) => s + r.unit_price_RUB * (r.amount || 0), 0);
  return qty ? tot / qty : 0;
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function saveDebug(page, key) {
  await ensureDir(path.join(DEBUG_DIR, key));
  await fs.writeFile(path.join(DEBUG_DIR, key, "page.html"), await page.content(), "utf-8");
  try {
    await page.screenshot({ path: path.join(DEBUG_DIR, key, "screen.png"), fullPage: true });
  } catch {}
}

async function isAntiBot(page) {
  const html = (await page.content()).toLowerCase();
  return (
    html.includes("just a moment") ||
    html.includes("checking your browser") ||
    html.includes("verify you are human") ||
    html.includes("access denied") ||
    html.includes("cloudflare")
  );
}

async function fetchTopOffers(page, url, minQty, key) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

  // маскируем webdriver-след
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  // дожидаемся сетевых запросов/дорисовки
  await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});

  // если антибот — фиксируем и выходим
  if (await isAntiBot(page)) {
    await saveDebug(page, key);
    throw new Error("Anti-bot page detected (Cloudflare/Turnstile).");
  }

  // ждём таблицу: возможны разные корни
  const selRows = [
    "table tbody tr",
    "tbody tr",
    "tr" // крайний fallback
  ];
  let foundSelector = null;
  for (const s of selRows) {
    const ok = await page.$(s);
    if (ok) { foundSelector = s; break; }
  }
  if (!foundSelector) {
    await saveDebug(page, key);
    throw new Error("No table rows found");
  }

  // дополнительно ждём появление ценника с ₽
  await page.waitForFunction(
    (s) => {
      const rows = [...document.querySelectorAll(s)];
      return rows.some(tr => /₽/.test(tr.textContent || ""));
    },
    foundSelector,
    { timeout: 15000 }
  ).catch(() => {});

  // немного подождать дорисовку
  await page.waitForTimeout(1200);

  // парсим через "последний столбец = цена ₽, предпоследний = наличие"
  const parsed = await page.evaluate((s) => {
    function txt(n) { return (n?.textContent || "").trim(); }
    const rows = [...document.querySelectorAll(s)];
    const items = [];

    for (const tr of rows.slice(0, 40)) {
      const tds = [...tr.querySelectorAll("td")];
      if (tds.length < 2) continue;

      let priceText = txt(tds[tds.length - 1]);
      // подсказка: ищем ячейку где есть ₽, если последняя пуста
      if (!/₽/.test(priceText)) {
        const maybe = tds.map(txt).reverse().find(c => /₽/.test(c));
        if (maybe) priceText = maybe;
      }

      let qtyText = txt(tds[tds.length - 2]);
      // если не похоже на число — попробуем найти число в любом tds
      if (!/\d/.test(qtyText)) {
        const nums = tds.map(td => txt(td).match(/\d[\d\s.,]*/g)?.join(" ") || "").filter(Boolean);
        const vals = nums.map(n => parseFloat(n.replace(/\s+/g, "").replace(",", "."))).filter(Number.isFinite);
        if (vals.length) qtyText = String(Math.max(...vals));
      }

      // ссылка продавца (если есть)
      const a = tr.querySelector("a[href]");
      items.push({
        priceText,
        qtyText,
        link: a ? a.href : null
      });
    }

    return { items };
  }, foundSelector);

  let offers = parsed.items
    .map(r => ({
      amount: toFloat(r.qtyText),
      unit_price_RUB: toFloat(r.priceText),
      source: "funpay",
      link: r.link || null,
      ts: NOW(),
    }))
    .filter(o => o.unit_price_RUB > 0 && o.amount > 0);

  // сортируем по цене, фильтруем minQty
  offers = offers.sort((a, b) => a.unit_price_RUB - b.unit_price_RUB);
  if (minQty && Number.isFinite(minQty)) offers = offers.filter(o => o.amount >= minQty);

  // отбрасываем явные выбросы вокруг медианы
  if (offers.length >= 5) {
    const med = median(offers.map(o => o.unit_price_RUB)) || 1;
    const filtered = offers.filter(o => Math.abs(o.unit_price_RUB - med) / med <= 0.25);
    if (filtered.length >= 3) offers = filtered;
  }

  offers = offers.slice(0, TOP_N);

  if (!offers.length) {
    await saveDebug(page, key);
  }

  return offers;
}

async function main() {
  await ensureDir("dist");
  await ensureDir(DEBUG_DIR);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-gpu"
    ],
  });

  const context = await browser.newContext({
    locale: "ru-RU",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: {
      "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      "sec-ch-ua-platform": "\"Windows\"",
      "sec-ch-ua": "\"Chromium\";v=\"124\", \"Not:A-Brand\";v=\"99\"",
      "sec-ch-ua-mobile": "?0",
      "upgrade-insecure-requests": "1"
    }
  });

  const page = await context.newPage();

  const out = { updated_at: NOW(), source: "funpay", pairs: {} };

  for (const p of mapping.pairs) {
    if (!p.funpay_url) continue;
    const key = p.key || `${p.game}:${p.currency}`;
    try {
      const top = await fetchTopOffers(page, p.funpay_url, p.min_qty || 0, key);
      const price = vwap(top);
      out.pairs[key] = {
        game: p.game,
        currency: p.currency,
        price_RUB: Number((price || 0).toFixed(4)),
        change_24h: null,
        change_7d: null,
        updated_at: NOW(),
        trades_top5: top
      };
      console.log(`OK: ${key} rows=${top.length} vwap=${out.pairs[key].price_RUB}`);
    } catch (e) {
      console.error(`FAIL: ${key} — ${e.message}`);
      out.pairs[key] = {
        game: p.game,
        currency: p.currency,
        price_RUB: 0,
        change_24h: null,
        change_7d: null,
        updated_at: NOW(),
        trades_top5: []
      };
    }
  }

  await fs.writeFile("dist/rates.json", JSON.stringify(out, null, 2), "utf-8");
  await browser.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
