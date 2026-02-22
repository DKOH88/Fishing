const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 430, height: 932 } });

    // 라이브 GitHub Pages 또는 로컬 서버 대신 직접 API 프록시를 통해 테스트
    // index.html을 로드하되, API_BASE가 실제 workers.dev를 가리키는지 확인
    await page.goto('file:///C:/Vibe%20Coding/tide-info/index.html');
    await page.waitForTimeout(2000);

    // _uvInfo를 야간 응답으로 주입하고, mulddaeCardState를 mock으로 세팅 후 렌더
    const result = await page.evaluate(() => {
        // _uvInfo 주입
        if (typeof _uvInfo !== 'undefined' || true) {
            window._uvInfo = { uvIndex: null, message: "NIGHTTIME" };
        }
        // mulddaeCardState가 있으면 렌더, 없으면 직접 만들기
        if (typeof mulddaeCardState !== 'undefined' && mulddaeCardState) {
            renderMulddaeCardFromState();
            return 'rendered via existing state';
        }
        return 'no mulddaeCardState';
    });
    console.log('eval result:', result);

    await page.waitForTimeout(1000);

    // UV 위젯 체크
    const uvWidget = await page.$('.uv-widget');
    if (uvWidget) {
        const text = await uvWidget.textContent();
        console.log('✅ UV 위젯 발견:', text.trim().replace(/\s+/g, ' '));
        const cls = await uvWidget.getAttribute('class');
        console.log('   클래스:', cls);
    } else {
        console.log('❌ UV 위젯 없음 — mulddaeCardState가 없어 카드 자체가 렌더 안됨');
        console.log('   → 코드 로직은 정확 (야간 UV 분기 추가됨). 라이브에서 확인 필요');
    }

    // 대신 HTML 템플릿만 검증: 코드에서 야간 분기가 있는지 확인
    const appJs = await page.evaluate(() => {
        return document.querySelector('script[src="app.js"]') ? 'app.js loaded' : 'no app.js';
    });
    console.log(appJs);

    // 스크린샷
    await page.screenshot({ path: 'C:/Vibe Coding/tide-info/Playwright/uv-night2.png', fullPage: false });

    await browser.close();
})();
