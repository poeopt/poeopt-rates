// scripts/build.mjs — POEOPT FunPay Parser v3.0
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";

const ROOT = path.resolve(".");
const MAP_PATH = path.join(ROOT, "mapping.json");
const OUT_JSON = path.join(ROOT, "public", "rates.json");
const DEBUG_DIR = path.join(ROOT, "debug");

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sanitize = (name) => String(name).replace(/[:*?"<>|\\/\r\n]/g, "-").replace(/\s+/g, " ").trim();

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

async function readMapping() {
  const raw = await fs.readFile(MAP_PATH, "utf-8");
  return JSON.parse(raw);
}

// Parse a price string like "9.94", "10 006", "3.36" into a number
function parsePrice(text) {
  if (!text) return null;
  // Remove everything except digits, dots, commas, spaces
  let n = text.replace(/[₽руб\s]/g, "").trim();
  // Handle "10 006" -> "10006" (space as thousands separator)
  n = n.replace(/\s/g, "");
  // Handle comma as decimal separator
  n = n.replace(",", ".");
  // Remove any remaining non-numeric chars except dot
  n = n.replace(/[^0-9.]/g, "");
  const v = parseFloat(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Screenshot + HTML dump for debugging
async function dumpDebug(page, key, step = "") {
  const base = sanitize(`${key}${step ? "-" + step : ""}`);
  await ensureDir(DEBUG_DIR);
  try {
    await page.screenshot({ path: path.join(DEBUG_DIR, `${base}.png`), fullPage: false });
  } catch {}
  try {
    const html = await page.evaluate(() => {
      const item = document.querySelector('.tc-item:not(.hidden)');
      return item ? item.outerHTML.substring(0, 3000) : "NO_VISIBLE_ITEMS";
    });
    await fs.writeFile(path.join(DEBUG_DIR, `${base}.html`), html, "utf-8");
  } catch {}
}

// Close cookie/consent banners
async function closeBanners(page) {
  for (const sel of ["button.cookies-accept", ".fc-cta-consent button", "button.fc-cta-consent"]) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) await loc.click({ timeout: 2000 });
    } catch {}
  }
}

// Select league/server from dropdown
async function selectLeague(page, desiredLabel) {
  if (!desiredLabel) return false;
  const sel = page.locator('select[name="server"]');
  if (!(await sel.count())) return false;
  
  await sel.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  
  try {
    await sel.selectOption({ label: desiredLabel });
  } catch {
    // Fuzzy match
    const options = await sel.evaluate(el => Array.from(el.options).map(o => o.text));
    const found = options.find(t => t.trim().toLowerCase().includes(desiredLabel.trim().toLowerCase()));
    if (found) {
      await sel.selectOption({ label: found });
    } else {
      console.log(`  ⚠ League "${desiredLabel}" not found. Available: ${options.join(", ")}`);
      return false;
    }
  }
  
  // Wait for table to re-render after league selection
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(2000);
  return true;
}

// Wait for visible items after league selection
async function waitForVisibleItems(page, timeoutMs = 30000) {
  await page.waitForSelector('.tc-item', { timeout: timeoutMs }).catch(() => {});
  await sleep(1500);
  
  // Wait for at least some items to be visible (not .hidden)
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const count = await page.$$eval('.tc-item:not(.hidden)', nodes => nodes.length).catch(() => 0);
    if (count > 0) return count;
    await sleep(1000);
  }
  return 0;
}

// Extract trades from visible items
async function extractTrades(page, limit = 10) {
  const rawItems = await page.$$eval(".tc-item:not(.hidden)", (nodes, lim) => {
    const results = [];
    for (const node of nodes) {
      if (results.length >= lim) break;
      
      const amountEl = node.querySelector(".tc-amount");
      const priceEl = node.querySelector(".tc-price");
      
      // Amount: direct text content
      const amountText = amountEl ? (amountEl.innerText || amountEl.textContent || "").trim() : "";
      
      // Price: inside nested <div> within tc-price
      // Structure: <div class="tc-price" data-s="N"><div>PRICE <span class="unit">₽</span></div></div>
      let priceText = "";
      if (priceEl) {
        const innerDiv = priceEl.querySelector("div");
        if (innerDiv) {
          // Get text before the <span> tag
          const clone = innerDiv.cloneNode(true);
          const spans = clone.querySelectorAll("span");
          spans.forEach(s => s.remove());
          priceText = (clone.textContent || "").trim();
        }
        // Fallback: full innerText
        if (!priceText) {
          priceText = (priceEl.innerText || priceEl.textContent || "").trim();
        }
      }
      
      results.push({
        price: priceText,
        amount: amountText,
        // Debug: include raw HTML
        priceHTML: priceEl ? priceEl.innerHTML.substring(0, 200) : "",
      });
    }
    return results;
  }, limit);
  
  return rawItems;
}

// Main parse function for one game
async function parsePair(page, pair) {
  const result = {
    game: pair.game,
    currency: pair.currency,
    display_name: pair.display_name || pair.game,
    currency_name: pair.currency_name || pair.currency,
    league: pair.league || "",
    price_RUB: 0,
    change_24h: null,
    change_7d: null,
    updated_at: null,
    trades: [],
    trades_tops: [],
    sellers: 0,
    error: null,
  };

  // Open page
  const urls = [pair.funpay_url, pair.fallback_root ? pair.fallback_root + String(pair.chips || "") + "/" : null].filter(Boolean);
  let opened = false;
  for (const url of urls) {
    try {
      console.log(`  → Opening ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      opened = true;
      break;
    } catch {}
  }
  if (!opened) {
    result.error = "Failed to open FunPay page";
    return result;
  }

  await closeBanners(page);
  
  // Wait for page JS to initialize
  await sleep(2000);
  await dumpDebug(page, pair.key, "open");

  // Select league
  if (pair.league) {
    const selected = await selectLeague(page, pair.league);
    console.log(`  → League "${pair.league}": ${selected ? "selected" : "NOT FOUND"}`);
    await sleep(1500);
  }

  await dumpDebug(page, pair.key, "league-selected");

  // Wait for visible items
  const visibleCount = await waitForVisibleItems(page, 20000);
  console.log(`  → Visible items: ${visibleCount}`);
  
  if (visibleCount === 0) {
    result.error = "No visible items after league selection";
    await dumpDebug(page, pair.key, "no-items");
    return result;
  }

  // Extract trades
  const rawTrades = await extractTrades(page, pair.avg_top || 10);
  
  // Debug: dump raw data
  await ensureDir(DEBUG_DIR);
  await fs.writeFile(
    path.join(DEBUG_DIR, sanitize(`${pair.key}-raw.json`)),
    JSON.stringify(rawTrades, null, 2), "utf-8"
  ).catch(() => {});

  // Parse trades
  const trades = [];
  for (const raw of rawTrades) {
    const price = parsePrice(raw.price);
    const amount = parsePrice(raw.amount);
    if (price !== null && price > 0) {
      trades.push({ price, amount: amount || 0 });
    }
  }

  console.log(`  → Parsed ${trades.length} trades from ${rawTrades.length} raw items`);
  if (trades.length > 0) {
    console.log(`  → First trade: price=${trades[0].price}, amount=${trades[0].amount}`);
  } else if (rawTrades.length > 0) {
    console.log(`  → Raw[0]: price="${rawTrades[0].price}" amount="${rawTrades[0].amount}" html="${rawTrades[0].priceHTML.substring(0, 100)}"`);
  }

  // Count sellers
  result.sellers = visibleCount;
  
  if (!trades.length) {
    result.error = "No parseable prices";
    await dumpDebug(page, pair.key, "no-prices");
  }

  result.trades = trades;
  result.trades_tops = trades.map(t => t.price);
  result.price_RUB = trades.length ? trades[0].price : 0;
  result.updated_at = nowIso();
  await dumpDebug(page, pair.key, "done");
  return result;
}

// ─── BUILD ───
async function main() {
  await ensureDir(path.dirname(OUT_JSON));
  await ensureDir(DEBUG_DIR);

  const mapping = await readMapping();

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const ctx = await browser.newContext({
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
  });

  // Anti-detection: remove webdriver flag
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await ctx.newPage();

  const pairs = {};
  for (const pair of mapping) {
    console.log(`\n📊 Parsing ${pair.key} (${pair.display_name})...`);
    try {
      const res = await parsePair(page, pair);
      pairs[pair.key] = res;
      if (res.error) console.log(`  ❌ Error: ${res.error}`);
      else console.log(`  ✅ OK: ${res.trades.length} trades, price=${res.price_RUB}`);
    } catch (e) {
      console.log(`  ❌ Exception: ${e?.message || e}`);
      pairs[pair.key] = {
        game: pair.game,
        currency: pair.currency,
        display_name: pair.display_name || pair.game,
        currency_name: pair.currency_name || pair.currency,
        league: pair.league || "",
        price_RUB: 0,
        change_24h: null,
        change_7d: null,
        updated_at: nowIso(),
        trades: [],
        trades_tops: [],
        sellers: 0,
        error: (e && e.message) ? e.message : String(e),
      };
    }
  }

  await browser.close();

  const payload = {
    updated_at: nowIso(),
    source: "funpay",
    pairs,
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(payload, null, 2), "utf-8");
  console.log("\n✓ rates.json updated:", OUT_JSON);
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
});
