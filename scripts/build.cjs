// scripts/build.cjs  (CommonJS, без ESM)
// Сборка rates.json из Funpay + отладочные артефакты (HTML/PNG) с безопасными именами

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// ---------- утилиты ----------
function safeName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9._-]/g, "_");
}

async function saveDebug(stem, page) {
  try {
    await fs.promises.mkdir("debug", { recursive: true });
    const base = safeName(stem);
    const html = await page.content();
    await fs.promises.writeFile(path.join("debug", `${base}.html`), html, "utf8");
    await page.screenshot({ path: path.join("debug", `${base}.png`), fullPage: true }).catch(() => {});
  } catch (e) {
    console.error("saveDebug error:", e.message);
  }
}

function parseNumber(text) {
  if (!text) return NaN;
  const n = text
    .replace(/\s+/g, "")
    .replace(",", ".")
    .replace(/[^\d.]/g, "");
  return n ? Number(n) : NaN;
}

function vwap(top, minQty = 1) {
  if (!Array.isArray(top) || top.length === 0) {
    return { price_RUB: 0, trades_top5: [] };
  }
  let qtySum = 0;
  let costSum = 0;
  for (const t of top) {
    const q = Math.max(Number(t.qty || 0), minQty);
    if (!isFinite(t.price) || !isFinite(q) || q <= 0) continue;
    qtySum += q;
    costSum += q * t.price;
  }
  return {
    price_RUB: qtySum > 0 ? Number((costSum / qtySum).toFixed(2)) : 0,
    trades_top5: top
  };
}

// ---------- основной процесс ----------
(async () => {
  // читаем mapping
  const mappingRaw = await fs.promises.readFile(path.join("mapping.json"), "utf8");
  let pairs;
  try {
    pairs = JSON.parse(mappingRaw);
  } catch (e) {
    console.error("mapping.json: невалидный JSON");
    process.exit(1);
  }
  if (!Array.isArray(pairs)) {
    console.error("mapping.json должен быть массивом объектов");
    process.exit(1);
  }

  // chromium
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox",
    ],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
    viewport: { width: 1400, height: 1000 },
  });

  const out = {
    updated_at: new Date().toISOString(),
    source: "funpay",
    pairs: {},
  };

  for (const p of pairs) {
    const key = p.key;
    const funpayUrl = p.funpay_url;
    const game = p.game || "";
    const currency = p.currency || "";
    const minQty = Number(p.min_qty || 1);

    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    try {
      await page.goto(funpayUrl, { waitUntil: "domcontentloaded" });

      // небольшой «дыхательный» таймаут, чтобы успела догрузиться витрина
      await page.waitForTimeout(1500);

      // иногда у Funpay появляется кнопка «Показать ещё предложений»
      const moreBtn = await page.$('button:has-text("Показать ещё предложений")');
      if (moreBtn) {
        await moreBtn.click().catch(() => {});
        await page.waitForTimeout(1000);
      }

      // собираем карточки
      const offers = await page.evaluate(() => {
        // На витрине строки обычно— <a class="tc-item…"> …
        const rows = Array.from(document.querySelectorAll("a.tc-item"));
        const items = [];
        for (const row of rows) {
          const priceText =
            row.querySelector(".tc-price")?.textContent ||
            row.querySelector('[class*="price"]')?.textContent ||
            "";
          // наличие/объём (иногда рядом с иконкой монеты): «Наличие 6к» и т.п.
          const qtyCandidate =
            row.querySelector(".tc-amount")?.textContent ||
            row.querySelector('[class*="amount"]')?.textContent ||
            row.textContent;

          const priceStr = (priceText || "").trim();
          const qtyStr = (qtyCandidate || "").trim();

          items.push({ priceText: priceStr, qtyText: qtyStr });
        }
        return items;
      });

      // парсим числа
      const parsed = (offers || [])
        .map((o) => {
          const price = Number(
            (o.priceText || "")
              .replace(/\s+/g, "")
              .replace(",", ".")
              .replace(/[^\d.]/g, "")
          );
          // из строки «Наличие 3к», «6000», «47к» и т.п.
          let qty = 0;
          const mK = /(\d+(?:[.,]\d+)?)\s*к/i.exec(o.qtyText || "");
          const mN = /(\d+(?:[.,]\d+)?)/.exec(o.qtyText || "");
          if (mK) qty = Number(mK[1].replace(",", ".")) * 1000;
          else if (mN) qty = Number(mN[1].replace(",", "."));
          return { price, qty };
        })
        .filter((x) => isFinite(x.price) && x.price > 0);

      // ТОП-5 по цене
      const top5 = parsed.sort((a, b) => a.price - b.price).slice(0, 5);
      const { price_RUB, trades_top5 } = vwap(top5, minQty);

      out.pairs[key] = {
        game,
        currency,
        price_RUB,
        change_24h: null,
        change_7d: null,
        updated_at: new Date().toISOString(),
        trades_top5,
      };

      await saveDebug(key, page);
    } catch (e) {
      console.error(`[${key}] ошибка:`, e.message);
      out.pairs[key] = {
        game,
        currency,
        price_RUB: 0,
        change_24h: null,
        change_7d: null,
        updated_at: new Date().toISOString(),
        trades_top5: [],
      };
      await saveDebug(`${key}__error`, page);
    } finally {
      await page.close().catch(() => {});
    }
  }

  await browser.close().catch(() => {});

  // пишем dist
  await fs.promises.mkdir("dist", { recursive: true });
  await fs.promises.writeFile(
    path.join("dist", "rates.json"),
    JSON.stringify(out, null, 2),
    "utf8"
  );

  // простой index.html со ссылкой на JSON
  const indexHtml = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>poeopt-rates</title>
  <style>html,body{background:#111;color:#ddd;font:16px/1.5 system-ui,Segoe UI,Roboto,Arial;padding:24px}</style>
</head>
<body>
  <h1>poeopt-rates</h1>
  <p>Данные: <a href="rates.json">rates.json</a></p>
</body>
</html>`;
  await fs.promises.writeFile(path.join("dist", "index.html"), indexHtml, "utf8");

  console.log("✅ Готово: dist/rates.json + dist/index.html");
  process.exit(0);
})();
