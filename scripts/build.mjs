// scripts/build.mjs
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";

const ROOT = path.resolve(".");
const MAP_PATH = path.join(ROOT, "mapping.json");
const OUT_JSON = path.join(ROOT, "public", "rates.json");
const DEBUG_DIR = path.join(ROOT, "debug");

// ──────────────────────────────────────────────────────────────────────────────
// УТИЛИТЫ
// ──────────────────────────────────────────────────────────────────────────────
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitize(name) {
  // запрещённые для upload-artifact символы: ", :, <, >, |, *, ?, \r, \n
  return String(name).replace(/[":<>|*\?\r\n]/g, "-").replace(/\s+/g, "_");
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

async function writeJSON(p, data) {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
}

async function saveShot(page, fileBase) {
  await ensureDir(DEBUG_DIR);
  const file = path.join(DEBUG_DIR, `${sanitize(fileBase)}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
}

async function autoScroll(page, px = 1400) {
  try {
    await page.evaluate(async (delta) => {
      await new Promise((resolve) => {
        let total = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 400);
          total += 400;
          if (total >= delta) {
            clearInterval(timer);
            resolve();
          }
        }, 80);
      });
    }, px);
  } catch {}
}

// ──────────────────────────────────────────────────────────────────────────────
// ЛОГИКА РАБОТЫ С FUNPAY
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Выбор нужной лиги/сезона. Пытаемся по <select>, если его нет — по кастомному дропдауну.
 */
async function pickLeague(page, leagueText) {
  if (!leagueText) return false;

  // Попытка 1: обычный <select> c опцией
  const selects = page.locator("select");
  const count = await selects.count();
  for (let i = 0; i < count; i++) {
    const sel = selects.nth(i);
    try {
      const has = await sel.evaluate(
        (el, text) => Array.from(el.options).some((o) => o.textContent.trim() === text),
        leagueText
      );
      if (has) {
        await sel.selectOption({ label: leagueText }).catch(() => {});
        await page.waitForLoadState("networkidle").catch(() => {});
        await sleep(600);
        return true;
      }
    } catch {}
  }

  // Попытка 2: кастомный дропдаун около подписей "Лига / Cycle / Сервер / Season"
  const triggers = page.locator(
    'button, [role="button"], .select, .sm-select, .ui-select, .tc-select'
  );

  const trigCount = await triggers.count();
  for (let i = 0; i < trigCount; i++) {
    const btn = triggers.nth(i);
    try {
      const txt = (await btn.textContent())?.trim() ?? "";
      // открываем дропдаун, если он выглядит как селектор
      if (/(Лига|Cycle|Сервер|Season)/i.test(txt) || txt.length <= 2) {
        await btn.click({ timeout: 1200 }).catch(() => {});
        const opt = page.locator(`text="${leagueText}"`).first();
        if (await opt.count()) {
          await opt.click({ timeout: 1500 }).catch(() => {});
          await page.waitForLoadState("networkidle").catch(() => {});
          await sleep(600);
          return true;
        }
        // закрыть, если не нашли
        await page.keyboard.press("Escape").catch(() => {});
      }
    } catch {}
  }
  return false;
}

/**
 * Ждем любой «живой» список лотов и забираем первые n цен.
 * Возвращает массив чисел (цены), максимум n.
 */
async function grabTopPrices(page, n = 5) {
  // 1) ждем, когда появится ЛЮБОЙ контейнер с лотами
  const waitSelectors = [
    // часто встречающееся
    ".tc-item .tc-price",
    "table.tc-table",
    // альтернативные
    ".tc-list .tc-item",
    ".lots-list .tc-item",
    "[class*=tc-][class*=item] [class*=price]",
  ].join(", ");

  await page.waitForSelector(waitSelectors, { timeout: 15000 }).catch(() => {});

  // 2) пробуем вытащить цены из разных возможных разметок
  const prices = await page.evaluate(() => {
    const candidates = [
      ".tc-item .tc-price", // общий случай
      "table.tc-table .tc-price",
      ".lots-list .tc-item .tc-price",
      ".tc-list .tc-item .tc-price",
      // запасные варианты
      "[class*=tc-][class*=item] [class*=price]",
    ];

    function parsePrice(txt) {
      if (!txt) return null;
      const clean = txt
        .replace(/\s/g, "")
        .replace(",", ".")
        .replace(/[^\d.]/g, "");
      const v = parseFloat(clean);
      return Number.isFinite(v) ? v : null;
    }

    let raw = [];
    for (const css of candidates) {
      const found = Array.from(document.querySelectorAll(css))
        .map((el) => el.textContent?.trim())
        .filter(Boolean);
      const nums = found.map(parsePrice).filter((v) => typeof v === "number");
      if (nums.length >= 1) {
        raw = nums;
        break;
      }
    }
    return raw.slice(0, 20); // возьмем побольше; обрежем позже на стороне Node
  });

  // 3) если мало — чуть прокрутим и повторим попытку
  let top = prices;
  if (top.length < n) {
    await autoScroll(page, 1200);
    const again = await page.evaluate(() => {
      const candidates = [
        ".tc-item .tc-price",
        "table.tc-table .tc-price",
        ".lots-list .tc-item .tc-price",
        ".tc-list .tc-item .tc-price",
        "[class*=tc-][class*=item] [class*=price]",
      ];
      function parsePrice(txt) {
        if (!txt) return null;
        const clean = txt
          .replace(/\s/g, "")
          .replace(",", ".")
          .replace(/[^\d.]/g, "");
        const v = parseFloat(clean);
        return Number.isFinite(v) ? v : null;
      }
      for (const css of candidates) {
        const nums = Array.from(document.querySelectorAll(css))
          .map((el) => el.textContent?.trim())
          .filter(Boolean)
          .map(parsePrice)
          .filter((v) => typeof v === "number");
        if (nums.length) return nums;
      }
      return [];
    });
    if (again.length > top.length) top = again;
  }

  return top.filter(Number.isFinite).slice(0, n);
}

/**
 * Основная функция для одной пары (игра+валюта).
 */
async function scrapePair(page, pair) {
  const { key, game, currency, funpay_url, league, avg_top = 5 } = pair;
  const result = {
    game,
    currency,
    price_RUB: 0,
    change_24h: null,
    change_7d: null,
    updated_at: null,
    trades_tops: [],
    error: null,
  };

  const tag = `${game}:${currency}`;
  const shotBase = `${tag}-${nowIso()}`;

  try {
    await page.goto(funpay_url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    await saveShot(page, `${tag}-opened`);

    // Лига/сезон
    const picked = await pickLeague(page, league).catch(() => false);
    if (picked) {
      await saveShot(page, `${tag}-league-picked`);
    }

    // Сбор цен
    const top = await grabTopPrices(page, avg_top);
    if (top.length === 0) {
      result.error = `Не найдены цены. Пытались искать .tc-price / table.tc-table`;
      await saveShot(page, `${tag}-no-prices`);
    } else {
      result.trades_tops = top.slice(0, avg_top);
      result.price_RUB = result.trades_tops[0] ?? 0; // показываем первую (самую дешёвую)
      result.updated_at = nowIso();
      await saveShot(page, `${tag}-ok`);
    }
  } catch (e) {
    result.error = String(e?.message || e);
    await saveShot(page, `${tag}-error`);
  }
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// RUN
// ──────────────────────────────────────────────────────────────────────────────
(async () => {
  const mapping = JSON.parse(await fs.readFile(MAP_PATH, "utf8"));

  const data = {
    updated_at: nowIso(),
    source: "funpay",
    pairs: {}, // key: {...}
  };

  await ensureDir(DEBUG_DIR);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const context = await browser.newContext({
      locale: "ru-RU",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    });
    const page = await context.newPage();

    for (const cfg of mapping) {
      const key = cfg.key;
      data.pairs[key] = await scrapePair(page, cfg);
    }

    await writeJSON(OUT_JSON, data);
    console.log(`DONE: ${OUT_JSON}`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();
