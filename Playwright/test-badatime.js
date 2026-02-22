/**
 * 바다타임 유속% 통합 테스트
 * - 물때 카드에 바다타임 데이터가 표시되는지 확인
 * - fallback(계산값+*)이 정상 동작하는지 확인
 */
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 430, height: 932 } });

    // 라이브 앱(file:// 프로토콜로 로드, Worker API는 실제 호출)
    await page.goto('file:///C:/Vibe%20Coding/tide-info/index.html');
    console.log('📄 페이지 로드 완료');

    // 초기 데이터 로딩 대기 (조위+물때)
    await page.waitForTimeout(5000);

    // 물때 카드 확인
    const mulddaeCard = await page.$('#mulddaeCard');
    if (!mulddaeCard) {
        console.log('❌ 물때 카드 없음');
        await browser.close();
        return;
    }
    const cardDisplay = await mulddaeCard.evaluate(el => getComputedStyle(el).display);
    console.log('📋 물때 카드 display:', cardDisplay);

    // 유속% 값 확인
    const pctEl = await page.$('.mulddae-pct-value');
    if (pctEl) {
        const pctText = await pctEl.textContent();
        const pctTitle = await pctEl.getAttribute('title');
        console.log(`✅ 유속% 표시: "${pctText.trim()}"  (tooltip: ${pctTitle})`);

        if (pctText.includes('*')) {
            console.log('   → 조차 기반 추정값 (바다타임 데이터 미사용)');
        } else if (pctText.includes('%')) {
            console.log('   → 바다타임 실데이터 ✓');
        }
    } else {
        console.log('❌ 유속% 요소 없음');
    }

    // * 조차 기반 추정 표시 확인
    const sourceEl = await page.$('.mulddae-pct-source');
    if (sourceEl) {
        const sourceText = await sourceEl.textContent();
        console.log(`📌 출처 표시: "${sourceText.trim()}"`);
    } else {
        console.log('📌 출처 표시 없음 (바다타임 실데이터 사용 중)');
    }

    // 콘솔 로그에서 badatime 관련 확인
    const logs = [];
    page.on('console', msg => {
        if (msg.text().includes('badatime') || msg.text().includes('바다타임')) {
            logs.push(msg.text());
        }
    });

    // badatime API 호출 확인을 위해 네트워크 이벤트 감지
    const badatimeRequests = [];
    page.on('response', async resp => {
        if (resp.url().includes('/api/badatime')) {
            const body = await resp.json().catch(() => null);
            badatimeRequests.push({ url: resp.url(), status: resp.status(), body });
        }
    });

    // 페이지 리로드로 badatime 요청 확인
    await page.reload();
    await page.waitForTimeout(6000);

    if (badatimeRequests.length > 0) {
        console.log(`\n🌐 바다타임 API 호출 ${badatimeRequests.length}건:`);
        badatimeRequests.forEach(r => {
            console.log(`   ${r.url} → ${JSON.stringify(r.body)}`);
        });
    } else {
        console.log('\n🌐 바다타임 API 호출 0건 (file:// 프로토콜이라 CORS 제한 가능)');
    }

    // 최종 상태 확인
    const finalPct = await page.$('.mulddae-pct-value');
    if (finalPct) {
        const text = await finalPct.textContent();
        console.log(`\n🏁 최종 유속%: "${text.trim()}"`);
    }

    // 스크린샷
    await page.screenshot({ path: 'C:/Vibe Coding/tide-info/Playwright/badatime-test.png', fullPage: false });
    console.log('\n📸 스크린샷: Playwright/badatime-test.png');

    if (logs.length > 0) {
        console.log('\n📋 콘솔 로그:');
        logs.forEach(l => console.log('   ', l));
    }

    await browser.close();
})();
