async function scrapeFunpayPage(browser, url, keyForScreenshot) {
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  });

  const parsePriceRUB = (t) => {
    if (!t) return null;
    const m = String(t).replace(/\s/g, '').match(/([\d.,]+)\s*₽/i);
    if (!m) return null;
    const num = m[1].replace(',', '.');
    const v = Number(num);
    return Number.isFinite(v) ? v : null;
  };

  const safe = (s) => String(s).replace(/[^\w.-]+/g, '_');

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

    // Закрыть возможные баннеры/куки
    const maybeClick = async (sel) => {
      const el = await page.$(sel);
      if (el) { try { await el.click({ timeout: 1000 }); } catch {} }
    };
    await maybeClick('button:has-text("Понятно")');
    await maybeClick('button:has-text("Окей")');
    await maybeClick('button:has-text("Принять")');
    await page.keyboard.press('Escape').catch(()=>{});

    // Ждём, пока появятся строки с ценой
    await page.waitForSelector('.dtc-item .dtc-price', { timeout: 20000 }).catch(()=>{});
    // На всякий случай ждём сетевую тишину и ещё чуть-чуть
    await page.waitForLoadState('networkidle').catch(()=>{});
    await page.waitForTimeout(1200);

    // Попробовать принудительно отсортировать по цене (если заголовок кликабелен)
    // Некоторые страницы позволяют кликнуть по колонке "Цена"
    const headerCandidates = [
      // кнопка/кликалка «Цена»
      'button:has-text("Цена")',
      // заголовочная ячейка с классом price (если есть)
      '.dtc-thead .dtc-price, .dtc-header .dtc-price'
    ];
    for (const sel of headerCandidates) {
      const h = await page.$(sel);
      if (h) {
        try {
          await h.click({ timeout: 1000 });
          await page.waitForTimeout(800);
        } catch {}
        break;
      }
    }

    // Берём первые 5 цен из видимых строк
    const texts = await page.$$eval('.dtc-item .dtc-price', nodes =>
      nodes.slice(0, 5).map(n => (n.textContent || '').trim())
    );

    let prices = texts
      .map(t => {
        // На странице часто показывается и средняя/диапазон —
        // берём из текстов все «NNN ₽» и вытаскиваем первое попадание.
        const m = t.match(/([\d\s.,]+)\s*₽/);
        return m ? m[0] : t;
      })
      .map(parsePriceRUB)
      .filter(v => v != null);

    // Фолбэк: вдруг из-за вёрстки не нашли по .dtc-price — ищем любые «₽»
    if (prices.length === 0) {
      const anyTexts = await page.$$eval(':text(/₽/i)', nodes =>
        nodes.slice(0, 30).map(n => (n.textContent || '').trim())
      );
      prices = anyTexts.map(parsePriceRUB).filter(v => v != null).slice(0, 5);
    }

    // Скриншот для дебага
    try {
      const fs = require('fs');
      const path = require('path');
      const DEBUG_DIR = path.join(process.cwd(), 'debug');
      if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(DEBUG_DIR, `${safe(keyForScreenshot)}.png`),
        fullPage: true
      });
    } catch {}

    if (prices.length === 0) {
      return { price_RUB: 0, trades_top5: [] };
    }
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    return {
      price_RUB: Number(avg.toFixed(2)),
      trades_top5: prices.map(p => ({ price_RUB: p })),
    };
  } finally {
    await page.close().catch(()=>{});
  }
}
