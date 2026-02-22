const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
    await page.goto('file:///C:/Vibe%20Coding/tide-info/index.html');
    // 포항 선택 후 로딩 대기
    await page.waitForTimeout(4000);

    // UV 위젯이 있는지 확인
    const uvWidget = await page.$('.uv-widget');
    if (uvWidget) {
        const text = await uvWidget.textContent();
        console.log('✅ UV 위젯 발견:', text.trim().replace(/\s+/g, ' '));
        const cls = await uvWidget.getAttribute('class');
        console.log('   클래스:', cls);
    } else {
        console.log('❌ UV 위젯 없음');
    }

    // 스크린샷
    await page.screenshot({ path: 'C:/Vibe Coding/tide-info/Playwright/uv-night.png', fullPage: false });
    console.log('📸 스크린샷 저장: Playwright/uv-night.png');

    await browser.close();
})();
