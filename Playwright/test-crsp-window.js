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
        const resp = await fetch('https://tide-api-proxy.odk297.workers.dev/api/current-window?obsCode=16LTC03&reqDate=' + dateStr);
        if (!resp.ok) return { date: dateStr, status: 'HTTP ' + resp.status };
        const data = await resp.json();
        if (!data || !data.dailyMaxSpeeds) return { date: dateStr, status: 'NO_DATA', raw: JSON.stringify(data).substring(0, 200) };
        return {
          date: dateStr,
          windowSize: data.dailyMaxSpeeds.length,
          sample: data.dailyMaxSpeeds.slice(0, 3)
        };
      } catch(e) {
        return { date: dateStr, error: e.message };
      }
    }, d);
    console.log(JSON.stringify(result));
  }
  await browser.close();
})();
