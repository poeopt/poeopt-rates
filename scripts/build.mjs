// scripts/build.mjs
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// paths
const ROOT = path.resolve(".");
const MAP_PATH = path.join(ROOT, "mapping.json");
const OUT_JSON = path.join(ROOT, "public", "rates.json");
const DEBUG_DIR = path.join(ROOT, "debug");

// ─────────────────────────────────────────────────────────────────────────────
// utils
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitize(name) {
  // для upload-artifact: убираем запрещённые символы (в т.ч. двоеточие)
  return String(name).replace(/[":<>|?*\\/\r\n]/g, "-").replace(/\s+/g, "_");
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

async function saveDebug(key, page, extra = {}) {
  const safe = sanitize(key);
  const base = path.join(DEBUG_DIR, safe);
  const shot = `${base}.png`;
  const html = `${base}.html`;
  await ensureDir(DEBUG_DIR);
  try {
    await page.screenshot({ path: shot, fullPage: true });
  } catch {}
  try {
    await fs.writeFile(html, await page.content(), "utf8");
  } catch {}
  // небольшая текстовая сводка
  if (extra && Object.keys(extra).length) {
    await fs.writeFile(`${base}.json`, JSON.stringify(extra, null, 2), "utf8");
  }
}

// ждём первый из селекторов
async function waitAny(page, selectors, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const s of selectors) {
      const el = await page.$(s);
      if (el) return el;
    }
    await sleep(100);
  }
  throw new Error(
    `waitAny timeout ${timeout}ms. selectors: ${selectors.join(", ")}`
  );
}

// выбираем опцию по видимому тексту (label)
async function selectByLabel(page, sel, label) {
  if (!label) return;
  const el = await page.$(sel);
  if (!el) return;
  try {
    // стандартный путь
    const result = await page.selectOption(sel, { label });
    if (result && result.length) return true;
  } catch {}
  // fallback: ищем option вручную и выбираем value
  const value = await page.$eval(
    sel,
    (node, label) => {
      const opts = Array.from(node.querySelectorAll("option"));
      const found =
        opts.find((o) => (o.textContent || "").trim() === label) ||
        opts.find((o) =>
          (o.textContent || "").trim().toLowerCase().includes(label.toLowerCase())
        );
      return found ? found.value : null;
    },
    label
  );
  if (value) {
    try {
      const result = await page.selectOption(sel, { value });
      if (result && result.length) return true;
    } catch {}
  }
  return false;
}

// извлекаем цены, сортируем по возрастанию, берём ТОП-5
async function extractTop5Prices(page) {
  // ждём, пока появятся карточки или таблица с ценами
  await waitAny(
    page,
    [
      ".tc-item .tc-price", // карточки
      "table.tc-table .tc-item", // старая таблица
      ".showcase-table .tc-item .tc-price",
    ],
    20000
  );

  // забираем как можно больше видимых цен (и с карточек, и из таблицы)
  const all = await page.$$eval(
    [
      ".tc-item .tc-price",
      "table.tc-table .tc-item .tc-price",
      ".showcase-table .tc-item .tc-price",
    ].join(","),
    (nodes) =>
      nodes
        .map((n) => {
          // в блоке обычно: <div class="tc-price"><div><span class="unit">₽</span> 1.27</div></div>
          const t = (n.textContent || "")
            .replace(/\u00a0/g, " ")
            .replace(/[^\d.,]/g, "")
            .trim();
          if (!t) return null;
          // меняем запятую на точку и парсим
          const num = parseFloat(t.replace(",", "."));
          return Number.isFinite(num) ? num : null;
        })
        .filter((x) => x !== null)
  );

  if (!all.length) return [];

  // берём ТОП-5 минимальных (может быть неотсортированная выдача у PoE2)
  const sorted = [...all].sort((a, b) => a - b);

  // немного схлопнем почти-дубликаты (например 0.02, 0.020, 0.021)
  const unique = [];
  for (const v of sorted) {
    if (!unique.length || Math.abs(unique[unique.length - 1] - v) > 1e-6) {
      unique.push(v);
    }
    if (unique.length >= 5) break;
  }
  return unique.slice(0, 5);
}

// основной парсер одной страницы
async function parsePair(page, pair) {
  const { key, funpay_url, league, type } = pair;

  const result = {
    game: pair.game,
    currency: pair.currency,
    price_RUB: 0,
    change_24h: null,
    change_7d: null,
    updated_at: null,
    trades_tops: [],
    error: null,
  };

  try {
    await page.goto(funpay_url, { waitUntil: "domcontentloaded", timeout: 45000 });
    // иногда Funpay лениво дорисовывает — чуть подождём
    await sleep(750);

    // ====== фильтры (лига / тип) ======
    // Лига (везде это select[name="server"])
    try {
      const leagueSelect = await page.$('select[name="server"]');
      if (leagueSelect && league) {
        await selectByLabel(page, 'select[name="server"]', league);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await sleep(600);
      }
    } catch {}

    // Тип (на PoE/PoE2 — второй селект в .showcase-filters; на страницах конкретной валюты может отсутствовать)
    if (type) {
      try {
        const selects = await page.$$(".showcase-filters select");
        const typeSelect = await (async () => {
          for (const s of selects) {
            const name = (await s.getAttribute("name")) || "";
            if (name !== "server") return s;
          }
          return null;
        })();
        if (typeSelect) {
          const sel = await typeSelect.evaluate((n) => n.matches("select") ? n : null);
          if (sel) {
            const css = await typeSelect.evaluate((n) => {
              const id = n.getAttribute("id");
              return id ? `#${id}` : null;
            });
            const typeSelector =
              css || (await typeSelect.evaluate(() => null)) || ".showcase-filters select:not([name=server])";
            await selectByLabel(page, typeSelector, type);
            await page.waitForLoadState("domcontentloaded").catch(() => {});
            await sleep(600);
          }
        }
      } catch {}
    }

    // иногда после смены фильтров остаётся "ленивая" пагинация, на всякий — ждём карточки/цены
    await waitAny(
      page,
      [".tc-item .tc-price", "table.tc-table .tc-item .tc-price", ".showcase-table .tc-item .tc-price"],
      20000
    );

    // собираем цены
    const tops = await extractTop5Prices(page);

    if (!tops.length) {
      result.error = "Нет видимых цен";
    } else {
      result.trades_tops = tops;
      result.price_RUB = tops[0] ?? 0;
      result.updated_at = nowIso();
    }

    // лог-скрин
    await saveDebug(key, page, { key, funpay_url, league, type, tops: result.trades_tops });
  } catch (e) {
    result.error = String(e?.message || e);
    // лог-скрин при ошибке
    try {
      await saveDebug(`${key}__error`, page, { key, funpay_url, league, type, error: result.error });
    } catch {}
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// main
(async () => {
  await ensureDir(path.dirname(OUT_JSON));
  await ensureDir(DEBUG_DIR);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  let mapping = [];
  try {
    mapping = JSON.parse(await fs.readFile(MAP_PATH, "utf8"));
  } catch (e) {
    console.error("mapping.json read error:", e);
    await browser.close();
    process.exit(1);
  }

  const out = {
    updated_at: nowIso(),
    source: "funpay",
    pairs: {},
  };

  for (const pair of mapping) {
    console.log("→ parse", pair.key, pair.funpay_url);
    const data = await parsePair(page, pair);
    out.pairs[pair.key] = data;
    // небольшая пауза между страницами
    await sleep(500);
  }

  await fs.writeFile(OUT_JSON, JSON.stringify(out, null, 2), "utf8");
  await browser.close();
  console.log("done:", OUT_JSON);
})();
