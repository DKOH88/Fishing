const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const page = await context.newPage();

  const logs = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('__CRSP_DBG__') || text.includes('[crsp 정규화]') || text.includes('crsp 윈도우')) logs.push(text);
  });

  await page.goto('http://localhost:8080', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(10000);

  // fetchCurrentData의 crsp 섹션 앞에 디버그 로그 삽입 (런타임 패치)
  await page.evaluate(() => {
    const origFetch = window.fetchCurrentData || null;
    // 전역 변수로 crsp 진단 로그 추가
    window.__crspDebugLog = [];
  });

  // 과거로 5일
  for (let i = 0; i < 5; i++) {
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

    // 직접 crsp 데이터 확인: 현재 조류 예보점에서 해당일 crsp API 호출
    const diag = await page.evaluate(async (dateStr) => {
      const cStation = document.getElementById('currentSelect').value;
      if (!cStation) return { cStation: 'EMPTY', reason: 'no current station' };

      try {
        const resp = await fetch('https://tide-api-proxy.odk297.workers.dev/api/current?obsCode=' + cStation + '&reqDate=' + dateStr.replace(/-/g, '') + '&numOfRows=300&pageNo=1&min=10');
        const data = await resp.json();
        const items = data && data.body && data.body.items && data.body.items.item;
        if (!items) return { cStation, reason: 'no items in response' };
        const arr = Array.isArray(items) ? items : [items];

        // 시간 필터 (05~18시) 적용
        const timeFiltered = arr.filter(item => {
          const dt = item.predcDt || item.pred_dt || '';
          const t = dt.length >= 16 ? dt.substring(11, 16) : '';
          return t >= '05:00' && t <= '18:00';
        });

        const crspValues = timeFiltered.map(i => parseFloat(i.crsp) || 0).filter(s => s > 0);
        const maxCrsp = crspValues.length > 0 ? Math.max(...crspValues) : null;

        return {
          cStation,
          totalItems: arr.length,
          timeFilteredCount: timeFiltered.length,
          crspCount: crspValues.length,
          maxCrsp: maxCrsp ? maxCrsp.toFixed(1) : 'NULL'
        };
      } catch(e) {
        return { cStation, error: e.message };
      }
    }, dateText);

    const crspLog = logs.find(l => l.includes('[crsp 정규화]'));
    const failLog = logs.find(l => l.includes('crsp 윈도우'));

    console.log(dateText + ': ' + JSON.stringify(diag) + (crspLog ? ' → ' + crspLog.match(/pct=\d+%/)?.[0] : '') + (failLog ? ' → FAIL' : ''));
  }

  await browser.close();
})();
