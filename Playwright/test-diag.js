const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const page = await context.newPage();

  const logs = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[crsp')) logs.push(text);
  });

  await page.goto('http://localhost:8080', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(10000);

  // 과거 3일
  for (let i = 0; i < 3; i++) {
    await page.waitForSelector('#btnPrev:not([disabled])', { timeout: 30000 });
    await page.click('#btnPrev');
    await page.waitForTimeout(500);
  }
  await page.waitForSelector('#btnNext:not([disabled])', { timeout: 30000 });
  await page.waitForTimeout(2000);

  for (let i = 0; i < 5; i++) {
    logs.length = 0;
    await page.waitForSelector('#btnNext:not([disabled])', { timeout: 30000 });
    await page.click('#btnNext');
    await page.waitForSelector('#btnNext:not([disabled])', { timeout: 30000 });
    await page.waitForTimeout(1000);

    const dateText = await page.evaluate(() => document.getElementById('dateInput').value);
    console.log('=== ' + dateText + ' ===');
    logs.forEach(l => console.log('  ' + l));
    if (logs.length === 0) console.log('  (no crsp logs at all - fetchCurrentData crsp section not reached)');
  }

  await browser.close();
})();
