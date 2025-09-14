// scripts/build.js — надёжный парсер + отладочные дампы
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
    .replace(/\u00A0/g, " ")      // nbsp
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

async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }

async function fetchTopOffers(page, url, minQty = 0, key = "pair") {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

  // немного маскировки против антиботов
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  // дождаться реального контента
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForSelector("table, tbody tr, tr", { timeout: 25000 });

  // иногда таблица дорисовывается — дать время
  await page.waitForTimeout(1800);

  // парсим максимально универсально
  const parsed = await page.evaluate(() => {
    function txt(n) { return (n?.textContent || "").trim(); }

    const table = document.querySelector("table");
    let header = [];
    if (table) header = [...table.querySelectorAll("thead th")].map(th => txt(th).toLowerCase());

    const priceCol = header.findIndex(h => h.includes("цена"));
    const qtyCol   = header.findIndex(h => h.includes("налич") || h.includes("кол"));

    const rows = [...document.querySelectorAll("tbody tr")];
    const fallBackRows = rows.length ? rows : [...document.querySelectorAll("tr")].slice(1, 60);

    const items = fallBackRows.map(tr => {
      const tds = [...tr.querySelectorAll("td")].map(td => txt(td));
      const a   = tr.querySelector("a[href]");

      // 1) по индексам, если нашли заголовки
      let priceText = (priceCol >= 0 && tds[priceCol]) || "";
      let qtyText   = (qtyCol   >= 0 && tds[qtyCol])   || "";

      // 2) fallback: ищем «₽» / числа в ячейках
      if (!priceText || !/[₽pP]/.test(priceText)) {
        const pCell = tds.find(c => /₽/.test(c) || /\d[\d\s.,]*\s?[pP]/.test(c));
        if (pCell) priceText = pCell;
      }
      if (!qtyText) {
        // берём самую большую цифру в строке как "наличие"
        const nums = tds.map(c => (c.match(/\d[\d\s.,]*/g) || []).join(" ")).filter(Boolean);
        const vals = nums.map(n => parseFloat(n.replace(/\s+/g, "").replace(",", "."))).filter(Number.isFinite);
        if (vals.length) qtyText = String(Math.max(...vals));
      }

      return {
        priceText,
        qtyText,
        link: a ? a.href : null,
      };
    });

    return { items };
  });

  let offers = parsed.items
    .map(r => ({
      amount: toFloat(r.qtyText),
      unit_price_RUB: toFloat(r.priceText),
      source: "funpay",
      link: r.link || null,
      ts: NOW(),
    }))
    .filter(o => o.unit_price_RUB > 0 && o.amount > 0)
    .sort((a, b) => a.unit_price_RUB - b.unit_price_RUB);

  if (minQty && Number.isFinite(minQty)) {
    offers = offers.filter(o => o.amount >= minQty);
  }

  offers = offers.slice(0, TOP_N);

  if (offers.length >= 3) {
    const med = median(offers.map(o => o.unit_price_RUB)) || 1;
    const filtered = offers.filter(o => Math.abs(o.unit_price_RUB - med) / med <= 0.25);
    if (filtered.length >= 3) offers = filtered;
  }

  // --- DEBUG: если пусто, сохраним снимок
  if (!offers.length) {
    await ensureDir(path.join(DEBUG_DIR, key));
    await fs.writeFile(path.join(DEBUG_DIR, key, "page.html"), await page.content(), "utf-8");
    await page.screenshot({ path: path.join(DEBUG_DIR, key, "screen.png"), fullPage: true }).catch(() => {});
  }

  return offers;
}

async function main() {
  await ensureDir("dist");
  await ensureDir(DEBUG_DIR);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    locale: "ru-RU",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    viewport: { width: 1400, height: 900 },
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
        trades_top5: top,
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
        trades_top5: [],
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
