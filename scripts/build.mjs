// scripts/build.mjs
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";

const ROOT = path.resolve(".");
const MAP_PATH = path.join(ROOT, "mapping.json");
const OUT_JSON = path.join(ROOT, "public", "rates.json");
const DEBUG_DIR = path.join(ROOT, "debug");

// ────────────────────────────────────────────────────────────────────────────────
// утилиты

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** имена файлов для артефактов без двоеточий и проблемных символов */
function sanitize(name) {
  return String(name)
    .replace(/[:"<>|?*\r\n]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

async function ensureDir(p) {
  try { await fs.mkdir(p, { recursive: true }); } catch {}
}

function parseRUB(text) {
  if (!text) return null;
  // оставляем цифры, точку/запятую
  const m = text.replace(/\s/g, "").replace(",", ".").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

// нажать «Показать ещё» если есть
async function clickShowMore(page) {
  // на FunPay эта кнопка часто имеет текст “Показать ещё ... предложений”
  const btn = page.locator('button:has-text("Показать ещё")');
  if (await btn.count()) {
    try { await btn.first().click({ timeout: 1000 }); return true; } catch {}
  }
  // бывают скрытые lazyload-кнопки
  const lazyBtn = page.locator(".lazyload-more:not(.hidden)");
  if (await lazyBtn.count()) {
    try { await lazyBtn.first().click({ timeout: 1000 }); return true; } catch {}
  }
  return false;
}

// плавный скролл вниз, чтобы лениво подгрузились карточки
async function autoScroll(page, steps = 6) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, 1200);
    await sleep(350);
  }
}

/** Собираем цены с карточек .tc-item .tc-price (работает и для chips, и для currencies) */
async function collectTopPrices(page, need = 5) {
  // ждём появления хотя бы какой-то цены
  await page.waitForSelector(".tc-price", { timeout: 20000 });

  let prices = [];
  // пробуем несколько раундов: скролл/показать ещё → собрать → достаточно? выходим
  for (let round = 0; round < 5; round++) {
    const texts = await page.$$eval(".tc-price", els =>
      els.map(e => e.textContent || "")
    );
    prices = texts.map(parseRUB).filter(v => Number.isFinite(v));

    if (prices.length >= need) break;

    let clicked = await clickShowMore(page);
    await autoScroll(page, 2);
    if (!clicked) await sleep(400);
  }

  // сортируем по возрастанию, берём уникальные первые N
  prices.sort((a, b) => a - b);
  const uniq = [];
  for (const p of prices) {
    if (!uniq.length || Math.abs(uniq[uniq.length - 1] - p) > 1e-9) uniq.push(p);
    if (uniq.length === need) break;
  }
  return uniq.slice(0, need);
}

/** выбрать сезон/лигу в выпадашке, если просят */
async function selectLeague(page, leagueText) {
  if (!leagueText) return;
  // общий селектор их фильтра сервера/лиги
  const dd = page.locator("select.showcase-filter-input");
  try {
    await dd.waitFor({ timeout: 8000 });
  } catch {
    // на некоторых чипс-страницах нет выпадашки – ок
    return;
  }

  // находим option по видимому тексту (частичное совпадение)
  const value = await dd.evaluate((sel, needle) => {
    const opts = Array.from(sel.options || []);
    const f = opts.find(o => (o.textContent || "").toLowerCase().includes(needle.toLowerCase()));
    return f ? f.value : null;
  }, leagueText);

  if (value) {
    await dd.selectOption(value);
    // даём странице отработать фильтр
    await page.waitForLoadState("networkidle").catch(() => {});
    await sleep(700);
  }
}

/** основной шаг по одной паре */
async function fetchPair(browser, pair, idx) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  let result = {
    game: pair.game,
    currency: pair.currency,
    price_RUB: 0,
    change_24h: null,
    change_7d: null,
    updated_at: null,
    trades_tops: [],
    error: null,
  };

  const debugBase = sanitize(`${idx + 1}-${pair.key}`);
  const dbgDir = path.join(DEBUG_DIR, debugBase);
  await ensureDir(dbgDir);

  try {
    await page.goto(pair.funpay_url, { waitUntil: "domcontentloaded", timeout: 45000 });
    // выбираем сезон/лигу (если указана)
    await selectLeague(page, pair.league);

    // собираем цены (ТОП-5 без усреднения)
    const tops = await collectTopPrices(page, Math.max(5, pair.avg_top || 5));
    result.trades_tops = tops;
    result.price_RUB = tops.length ? tops[0] : 0;
    result.updated_at = nowIso();

    // скрин + html в debug
    await page.screenshot({ path: path.join(dbgDir, "screen.png"), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(dbgDir, "page.html"), await page.content()).catch(() => {});
  } catch (e) {
    result.error = String(e?.message || e);
    // скрин ошибки
    try { await page.screenshot({ path: path.join(dbgDir, "error.png"), fullPage: true }); } catch {}
  } finally {
    await page.close();
  }
  return [pair.key, result];
}

async function main() {
  await ensureDir(path.dirname(OUT_JSON));
  await ensureDir(DEBUG_DIR);

  const raw = await fs.readFile(MAP_PATH, "utf8");
  /** @type {{key:string,game:string,currency:string,funpay_url:string,fallback_root?:string,league?:string,avg_top?:number}[]} */
  const mapping = JSON.parse(raw);

  const browser = await chromium.launch({ headless: true });
  const pairs = {};
  try {
    let i = 0;
    for (const m of mapping) {
      const [key, res] = await fetchPair(browser, m, i++);
      pairs[key] = res;
    }
  } finally {
    await browser.close();
  }

  const out = { updated_at: nowIso(), source: "funpay", pairs };
  await fs.writeFile(OUT_JSON, JSON.stringify(out, null, 2), "utf8");
  console.log("✅ rates.json updated:", OUT_JSON);
}

main().catch(async (e) => {
  console.error("Build failed:", e);
  process.exit(1);
});
