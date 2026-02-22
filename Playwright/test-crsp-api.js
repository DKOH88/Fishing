const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
  await page.goto('http://localhost:8080', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  const dates = ['20260217','20260218','20260219','20260220','20260221','20260222'];
  for (const d of dates) {
    const result = await page.evaluate(async (dateStr) => {
      try {
        const resp = await fetch('https://tide-api-proxy.odk297.workers.dev/api/current?obsCode=16LTC03&reqDate=' + dateStr + '&numOfRows=300&pageNo=1&min=10');
        const data = await resp.json();
        const items = data && data.body && data.body.items && data.body.items.item;
        if (!items) return { date: dateStr, status: 'NO_ITEMS' };
        const arr = Array.isArray(items) ? items : [items];
        const crspValues = arr.map(i => parseFloat(i.crsp) || 0).filter(s => s > 0);
        return {
          date: dateStr,
          total: arr.length,
          crspCount: crspValues.length,
          maxCrsp: crspValues.length > 0 ? Math.max(...crspValues).toFixed(1) : 'N/A'
        };
      } catch(e) {
        return { date: dateStr, error: e.message };
      }
    }, d);
    console.log(JSON.stringify(result));
  }
  await browser.close();
})();
