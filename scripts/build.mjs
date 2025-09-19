// scripts/build.mjs
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";

const ROOT = path.resolve(".");
const MAP_PATH = path.join(ROOT, "mapping.json");
const OUT_JSON = path.join(ROOT, "public", "rates.json");
const DEBUG_DIR = path.join(ROOT, "debug");

// ───────────────────────────────────────────────────────────────────────────────
// УТИЛИТЫ
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// запрещённые для upload-artifact символы
const sanitize = (name) => String(name).replace(/[:*?"<>|\\/\r\n]/g, "-").replace(/\s+/g, " ").trim();

// гарантируем каталоги
async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

// чтение JSON карты
async function readMapping() {
  const raw = await fs.readFile(MAP_PATH, "utf-8");
  const arr = JSON.parse(raw);
  return arr;
}

// скрин страницы + html кусочек для дебага
async function dumpDebug(page, key, step = "") {
  const base = sanitize(`${key}${step ? "-" + step : ""}`);
  await ensureDir(DEBUG_DIR);
  try {
    await page.screenshot({ path: path.join(DEBUG_DIR, `${base}.png`), fullPage: true });
  } catch {}
}

// извлекаем числа из текстового узла с ценой
function parsePrice(text) {
  if (!text) return null;
  const n = text.replace(/\s/g, "").replace(/[^0-9.,]/g, "").replace(",", ".");
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : null;
}

// общий селектор цен в обеих возможных вёрстках
const PRICE_CELLS =
  ".tc-table .tc-item:not(.lazyload-hidden) .tc-price, " +
  ".showcase-table .tc-item:not(.lazyload-hidden) .tc-price";

// ждём появления хотя бы одной видимой цены
async function waitPrices(page, timeoutMs = 30000) {
  await page.waitForSelector(PRICE_CELLS, { timeout: timeoutMs });
}

// читает до 5 первых видимых цен
async function readTop5(page) {
  const items = await page.$$eval(PRICE_CELLS, nodes => {
    const isVisible = (el) => {
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none") return false;
      // offsetParent null — чаще всего скрыт
      if (!el.offsetParent) return false;
      return true;
    };
    const out = [];
    for (const n of nodes) {
      if (!isVisible(n)) continue;
      const t = n.textContent || "";
      out.push(t);
      if (out.length >= 12) break; // небольшой буфер (бывает мусор вроде "шт" / "₽")
    }
    return out;
  });

  // превращаем в числа, фильтруем и берём первые 5
  const nums = items
    .map(parsePrice)
    .filter(v => v !== null && v >= 0)
    .slice(0, 5);

  return nums;
}

// кликаем/скрываем возможные баннеры согласия (если появятся)
async function closeBanners(page) {
  const candidates = [
    "button.cookies-accept",
    ".fc-cta-consent button",
    "button.fc-cta-consent",
  ];
  for (const sel of candidates) {
    const has = await page.locator(sel).first().catch(() => null);
    if (has && await has.count()) {
      try { await has.click({ timeout: 1000 }); } catch {}
    }
  }
}

// выбираем лигу по названию, если селектор есть
async function selectLeague(page, desiredLabel) {
  if (!desiredLabel) return false;
  const sel = page.locator('select[name="server"]');
  if (!(await sel.count())) return false;

  // подгрузка опций
  await sel.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  // пробуем выбрать по метке
  try {
    await sel.selectOption({ label: desiredLabel });
  } catch {
    // запасной вариант — ищем по includes (иногда кавычки/скобки отличаются)
    const options = await sel.evaluate(el => Array.from(el.options).map(o => o.text));
    const found = options.find(t => t.trim().toLowerCase().includes(desiredLabel.trim().toLowerCase()));
    if (found) {
      await sel.selectOption({ label: found });
    }
  }

  // ждём, пока таблица перерисуется
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(1200);
  return true;
}

// основной парсинг одной позиции
async function parsePair(page, pair) {
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

  const openTargets = [
    pair.funpay_url,
    // дополнительная запасная ссылка (если кто-то поменяет mapping на корень)
    pair.fallback_root ? pair.fallback_root + String(pair.chips || "").replace(/^\/+/, "") + "/" : null,
  ].filter(Boolean);

  let opened = false;
  for (const url of openTargets) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      opened = true;
      break;
    } catch {}
  }
  if (!opened) {
    result.error = "Не удалось открыть страницу Funpay";
    return result;
  }

  await closeBanners(page);
  await dumpDebug(page, pair.key, "open");

  // если нужна конкретная лига — выбираем
  try {
    await selectLeague(page, pair.league || "");
  } catch {}

  // небольшой «дохаживатель» — иногда таблица дорисовывается после idle
  await sleep(800);

  // ждём цен
  try {
    await waitPrices(page, 35000);
  } catch (e) {
    result.error = `waitForPrices timeout: ${e?.message || e}`;
    await dumpDebug(page, pair.key, "no-prices");
    return result;
  }

  // берём цены
  let top5 = [];
  try {
    top5 = await readTop5(page);
  } catch (e) {
    result.error = `extract error: ${e?.message || e}`;
    await dumpDebug(page, pair.key, "extract-error");
    return result;
  }

  // если вдруг таблица пустая/фильтры — зафиксируем
  if (!top5.length) {
    result.error = "Нет видимых цен";
    await dumpDebug(page, pair.key, "empty");
  }

  result.trades_tops = top5;
  result.price_RUB = top5.length ? top5[0] : 0;
  result.updated_at = nowIso();
  await dumpDebug(page, pair.key, "done");
  return result;
}

// ───────────────────────────────────────────────────────────────────────────────
// BUILD

async function main() {
  await ensureDir(path.dirname(OUT_JSON));
  await ensureDir(DEBUG_DIR);

  const mapping = await readMapping();

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const ctx = await browser.newContext({
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });

  const page = await ctx.newPage();

  const pairs = {};
  for (const pair of mapping) {
    try {
      const res = await parsePair(page, pair);
      pairs[pair.key] = res;
    } catch (e) {
      pairs[pair.key] = {
        game: pair.game,
        currency: pair.currency,
        price_RUB: 0,
        change_24h: null,
        change_7d: null,
        updated_at: nowIso(),
        trades_tops: [],
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
  console.log("✓ rates.json updated:", OUT_JSON);
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
});
