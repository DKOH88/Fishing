const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const page = await context.newPage();

  const logs = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[crsp 정규화]') || text.includes('crsp 윈도우 정규화 실패')) logs.push(text);
  });

  await page.goto('http://localhost:8080', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(10000);

  // 과거로 6일 이동 (버튼 활성화 대기)
  for (let i = 0; i < 6; i++) {
    await page.waitForSelector('#btnPrev:not([disabled])', { timeout: 30000 });
    await page.click('#btnPrev');
    await page.waitForTimeout(500);
  }
  // 마지막 이동 완료 대기
  await page.waitForSelector('#btnNext:not([disabled])', { timeout: 30000 });
  await page.waitForTimeout(2000);

  // 10일 연속 테스트 (버튼 활성화 = 모든 비동기 완료)
  for (let i = 0; i < 10; i++) {
    logs.length = 0;
    await page.waitForSelector('#btnNext:not([disabled])', { timeout: 30000 });
    await page.click('#btnNext');
    // 버튼이 다시 활성화될 때까지 대기 = fetchAll + currentPromise(crsp 포함) 완료
    await page.waitForSelector('#btnNext:not([disabled])', { timeout: 30000 });
    await page.waitForTimeout(500);

    const dateText = await page.evaluate(() => document.getElementById('dateInput').value);
    const crspLog = logs.find(l => l.includes('[crsp 정규화]'));
    const failLog = logs.find(l => l.includes('crsp 윈도우 정규화 실패'));
    const crspMatch = crspLog ? crspLog.match(/pct=(\d+)%/) : null;
    const crspPct = crspMatch ? crspMatch[1] : null;

    const cardText = await page.evaluate(() => {
      const el = document.querySelector('#mulddaeInfo');
      return el ? el.textContent : '';
    });
    const cardMatch = cardText.match(/(\d+)%/);
    const cardPct = cardMatch ? cardMatch[1] : null;

    let status;
    if (crspPct && cardPct) {
      status = crspPct === cardPct ? '✅' : '❌ card=' + cardPct + ' crsp=' + crspPct;
    } else if (failLog) {
      status = '⛔ ' + failLog.substring(0, 80);
    } else {
      status = '⚪ no crsp log';
    }
    console.log(dateText + ': card=' + (cardPct || 'N/A') + '%, crsp=' + (crspPct || '-') + '% ' + status);
  }

  await browser.close();
})();
