// scripts/build.js — версия с более надежным ожиданием таблицы
import fs from "fs/promises";
import { chromium } from "playwright";
import mapping from "../mapping.json" assert { type: "json" };

const NOW = () => new Date().toISOString();
const TOP_N = 5;

// аккуратный парсинг чисел из "0,99 ₽", "1 200" и т.п.
function toFloat(text) {
  if (!text) return 0;
  const s = String(text).replace(/\u00A0/g, " ").replace(/\s+/g, "").replace(",", ".").replace(/[^\d.]/g, "");
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

async function fetchTopOffers(page, url, minQty = 0) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

  // если страница дорисовывается — даём время
  await page.waitForTimeout(1200);

  // ждём таблицу с данными
  await page.waitForSelector("table tbody tr", { timeout: 20000 });

  const data = await page.evaluate(() => {
    const table = document.querySelector("table");
    if (!table) return { rows: [] };

    const heads = [...table.querySelectorAll("thead th")].map(th =>
      th.textContent.trim().toLowerCase()
    );
    const priceIdx = heads.findIndex(h => h.includes("цена"));
    const qtyIdx = heads.findIndex(h => h.includes("налич") || h.includes("кол"));

    const rows = [...table.querySelectorAll("tbody tr")].map(tr => {
      const tds = [...tr.querySelectorAll("td")].map(td => td.textContent.trim());
      const linkEl = tr.querySelector("a[href]");
      return {
        priceText: priceIdx >= 0 ? tds[priceIdx] : "",
        qtyText: qtyIdx >= 0 ? tds[qtyIdx] : "",
        link: linkEl ? linkEl.href : null,
      };
    });

    return { rows };
  });

  let offers = data.rows
    .map(r => ({
      amount: toFloat(r.qtyText),
      unit_price_RUB: toFloat(r.priceText),
      source: "funpay",
      link: r.link,
      ts: NOW(),
    }))
    .filter(o => o.unit_price_RUB > 0 && o.amount > 0)
    .sort((a, b) => a.unit_price_RUB - b.unit_price_RUB);

  // отбрасываем микролоты ниже порога
  if (minQty && Number.isFinite(minQty)) {
    offers = offers.filter(o => o.amount >= minQty);
  }

  // берём топ по цене
  offers = offers.slice(0, TOP_N);

  // мягкая очистка выбросов вокруг медианы ±25%
  if (offers.length >= 3) {
    const med = median(offers.map(o => o.unit_price_RUB)) || 1;
    const filtered = offers.filter(o => Math.abs(o.unit_price_RUB - med) / med <= 0.25);
    if (filtered.length >= 3) offers = filtered;
  }

  return offers;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    locale: "ru-RU",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  const out = { updated_at: NOW(), source: "funpay", pairs: {} };

  for (const p of mapping.pairs) {
    if (!p.funpay_url) continue;
    try {
      const top = await fetchTopOffers(page, p.funpay_url, p.min_qty || 0);
      const price = vwap(top);
      out.pairs[p.key] = {
        game: p.game,
        currency: p.currency,
        price_RUB: Number(price.toFixed(4)),
        change_24h: null,
        change_7d: null,
        updated_at: NOW(),
        trades_top5: top,
      };
      console.log(`OK: ${p.key} rows=${top.length} vwap=${out.pairs[p.key].price_RUB}`);
    } catch (e) {
      console.error(`FAIL: ${p.key} — ${e.message}`);
      out.pairs[p.key] = {
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

  await fs.mkdir("dist", { recursive: true });
  await fs.writeFile("dist/rates.json", JSON.stringify(out, null, 2), "utf-8");

  await browser.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
